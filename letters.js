import { Router } from 'express';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { requireAuth } from './middleware.js';
import { config } from './config.js';
import {
  generateTrackingCode,
  STATE_MESSAGES,
  LOST_LETTER_CHANCE,
  buildDisplayAddress,
  validateAddressParts,
} from './utils.js';
import { scheduleDelivery } from './delivery.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------
// POST /api/letters
// Cria uma carta padrão ('letter') ou um telegrama ('telegram').
// ---------------------------------------------------------------
router.post('/', async (req, res, next) => {
  try {
    const schema = z.object({
      kind: z.enum(['letter', 'telegram']).default('letter'),
      
      recipientAddress: z.string().min(5).max(120).optional(),
      recipientStreet: z.string().min(3).max(60).optional(),
      recipientNumber: z.string().min(1).max(6).optional(),
      recipientCity: z.string().min(2).max(40).optional(),
      recipientComplement: z.string().max(30).optional().nullable(),

      stamps: z.array(z.object({
        stampId: z.string().min(1),
        quantity: z.number().int().min(1).max(20),
      })).max(10).optional(),

      // AUMENTADO PARA 5MB PARA ACEITAR A IMAGEM
      attachedImage: z.string().max(5_000_000).optional().nullable(),

      title: z.string().max(120).nullable().optional(),
      content: z.string().min(1).max(50_000),
    });

    const data = schema.parse(req.body);

    // 1. Endereço
    let recipientAddress = data.recipientAddress
      ? String(data.recipientAddress).trim().replace(/\s+/g, ' ')
      : null;

    if (!recipientAddress && data.recipientStreet && data.recipientNumber && data.recipientCity) {
      if (!validateAddressParts({
        street: data.recipientStreet,
        number: data.recipientNumber,
        city: data.recipientCity,
      })) {
        return res.status(400).json({ error: 'Endereço do destinatário inválido.' });
      }
      recipientAddress = buildDisplayAddress({
        street: data.recipientStreet,
        number: data.recipientNumber,
        city: data.recipientCity,
        complement: data.recipientComplement,
      });
    }

    if (!recipientAddress) {
      return res.status(400).json({ error: 'Endereço do destinatário ausente.' });
    }

    const sender = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!sender) return res.status(404).json({ error: 'Remetente não encontrado.' });

    if (recipientAddress === sender.displayAddress) {
      return res.status(400).json({ error: 'Você não pode enviar mensagem para si mesmo.' });
    }

    const recipient = await prisma.user.findFirst({
      where: {
        displayAddress: {
          equals: recipientAddress,
          mode: 'insensitive',
        },
      },
    });
    const enderecoExiste = Boolean(recipient);

    // 2. Normaliza selos
    const stampMap = new Map();
    if (data.kind === 'letter') {
      for (const s of (data.stamps || [])) {
        stampMap.set(s.stampId, (stampMap.get(s.stampId) || 0) + s.quantity);
      }
    }
    const stampList = [...stampMap.entries()].map(([stampId, quantity]) => ({ stampId, quantity }));

    // 3. Extravio + ETA
    const vaiExtravirar = data.kind === 'telegram' ? false : Math.random() < LOST_LETTER_CHANCE;

    const now = Date.now();
    let etaMs;

    if (data.kind === 'telegram') {
      const min = 4 * 60 * 60 * 1000;
      const max = 5 * 60 * 60 * 1000;
      etaMs = min + Math.random() * (max - min);
    } else {
      if (config.delivery.devMode) {
        const min = config.delivery.devMinSeconds * 1000;
        const max = config.delivery.devMaxSeconds * 1000;
        etaMs = min + Math.random() * (max - min);
      } else {
        const days = config.delivery.minDays +
          Math.floor(Math.random() * (config.delivery.maxDays - config.delivery.minDays + 1));
        etaMs = days * 24 * 60 * 60 * 1000;
      }
    }
    const estimatedDelivery = new Date(now + etaMs);

    // 4. Transação única
    const letter = await prisma.$transaction(async (tx) => {
      // Cobrança do Telegrama
      if (data.kind === 'telegram') {
        const wallet = await tx.wallet.findUnique({ where: { userId: sender.id } });
        if (!wallet || wallet.balance < 50) {
          throw Object.assign(
            new Error('Saldo insuficiente. O telegrama custa 50 gemas.'),
            { status: 400 }
          );
        }
        
        await tx.wallet.update({
          where: { userId: sender.id },
          data: { balance: { decrement: 50 } },
        });

        await tx.walletTransaction.create({
          data: {
            userId: sender.id,
            type: 'debit',
            amount: 50,
            reason: `Envio de telegrama`,
            refType: 'telegram',
          },
        });
      }

      // Validação de posse de cada selo
      if (data.kind === 'letter' && stampList.length) {
        const owned = await tx.userStamp.findMany({
          where: {
            userId: sender.id,
            stampId: { in: stampList.map((s) => s.stampId) },
            source: 'purchased',
          },
        });
        const ownedMap = Object.fromEntries(owned.map((u) => [u.stampId, u.quantity]));

        for (const { stampId, quantity } of stampList) {
          const available = ownedMap[stampId] || 0;
          if (available < quantity) {
            throw Object.assign(
              new Error('Você não tem selos suficientes.'),
              { status: 400 }
            );
          }
        }
      }

      // Cria a correspondência
      const l = await tx.letter.create({
        data: {
          trackingCode: generateTrackingCode(),
          senderId: sender.id,
          recipientId: recipient?.id ?? null,
          recipientAddress,
          title: data.kind === 'telegram' ? null : (data.title ?? null),
          content: data.content,
          attachedImage: data.kind === 'telegram' ? null : (data.attachedImage ?? null),
          kind: data.kind,
          status: 'postada',
          estimatedDelivery,
        },
      });

      await tx.trackingEvent.create({
        data: {
          letterId: l.id,
          status: 'postada',
          message: data.kind === 'telegram' 
            ? 'Telegrama postado. Entrega em algumas horas.' 
            : STATE_MESSAGES.postada,
        },
      });

      // Registra os selos usados
      if (data.kind === 'letter') {
        for (const { stampId, quantity } of stampList) {
          const stamp = await tx.stamp.findUnique({ where: { id: stampId } });
          if (!stamp) {
            throw Object.assign(
              new Error(`Selo ${stampId} não encontrado.`),
              { status: 400 }
            );
          }

          await tx.letterStamp.create({
            data: {
              letterId: l.id,
              stampId: stamp.id,
              name: stamp.name,
              imagePath: stamp.imagePath,
              imageData: stamp.imageData,
              isCustom: stamp.isCustom,
              quantity,
            },
          });

          const after = await tx.userStamp.update({
            where: {
              userId_stampId_source: {
                userId: sender.id,
                stampId,
                source: 'purchased',
              },
            },
            data: { quantity: { decrement: quantity } },
          });

          if (after.quantity <= 0) {
            await tx.userStamp.delete({
              where: {
                userId_stampId_source: {
                  userId: sender.id,
                  stampId,
                  source: 'purchased',
                },
              },
            });
          }
        }
      }

      return l;
    });

    // 5. Agendamento
    if (data.kind === 'telegram') {
      await prisma.deliveryJob.create({
        data: {
          id: `${letter.id}:entregue`,
          letterId: letter.id,
          nextRunAt: estimatedDelivery,
          nextStatus: 'entregue',
        },
      }).catch(() => {});
    } else {
      await scheduleDelivery(letter.id, estimatedDelivery, {
        enderecoExiste,
        vaiExtravirar,
      }).catch((e) => console.error('[letters] schedule:', e.message));
    }

    // 6. Notificação
    if (recipient && data.kind === 'letter') {
      import('./push.js')
        .then(({ notifyLetterOnTheWay }) => notifyLetterOnTheWay(letter, sender, recipient))
        .catch(() => {});
    }

    res.status(201).json({
      id: letter.id,
      trackingCode: letter.trackingCode,
      status: letter.status,
      estimatedDelivery: letter.estimatedDelivery,
      recipientExists: enderecoExiste,
      kind: letter.kind,
      stampsUsed: stampList,
    });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// ROTAS DE LISTAGEM
// ---------------------------------------------------------------

router.get('/sent', async (req, res, next) => {
  try {
    const letters = await prisma.letter.findMany({
      where: { senderId: req.userId },
      orderBy: { sentAt: 'desc' },
      include: { stamps: true },
    });
    res.json(letters.map(serializeSent));
  } catch (e) { next(e); }
});

router.get('/incoming', async (req, res, next) => {
  try {
    const letters = await prisma.letter.findMany({
      where: {
        recipientId: req.userId,
        status: {
          notIn: ['entregue', 'extraviada', 'endereco_nao_localizado', 'devolvida', 'devolvendo_ao_remetente'],
        },
      },
      orderBy: { sentAt: 'desc' },
      include: { sender: { select: { username: true, displayAddress: true } } },
    });
    res.json(letters.map((l) => ({
      id: l.id,
      trackingCode: l.trackingCode,
      fromUsername: l.sender.username,
      from: l.sender.displayAddress,
      title: l.title,
      status: l.status,
      sentAt: l.sentAt,
      estimatedDelivery: l.estimatedDelivery,
      kind: l.kind,
    })));
  } catch (e) { next(e); }
});

router.get('/received', async (req, res, next) => {
  try {
    const letters = await prisma.letter.findMany({
      where: { recipientId: req.userId, status: 'entregue' },
      orderBy: { deliveredAt: 'desc' },
      include: {
        sender: { select: { username: true, displayAddress: true } },
        reads: { where: { userId: req.userId } },
        stamps: true,
      },
    });
    res.json(letters.map(serializeReceived));
  } catch (e) { next(e); }
});

router.get('/returned', async (req, res, next) => {
  try {
    const letters = await prisma.letter.findMany({
      where: {
        senderId: req.userId,
        status: { in: ['devolvida', 'devolvendo_ao_remetente', 'endereco_nao_localizado'] },
      },
      orderBy: { sentAt: 'desc' },
    });
    res.json(letters.map((l) => ({
      id: l.id,
      trackingCode: l.trackingCode,
      to: l.recipientAddress,
      title: l.title,
      status: l.status,
      sentAt: l.sentAt,
      returnedAt: l.returnedAt,
      failureReason: l.failureReason,
      kind: l.kind,
    })));
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// GET /api/letters/:id
// --- DETALHE (com regra de leitura) ---
// ---------------------------------------------------------------
router.get('/:id', async (req, res, next) => {
  try {
    const letter = await prisma.letter.findUnique({
      where: { id: req.params.id },
      include: {
        stamps: { include: { stamp: true } }, 
        sender: { select: { id: true, username: true, displayAddress: true } },
        recipient: { select: { id: true, username: true, displayAddress: true } },
        events: { orderBy: { createdAt: 'asc' } },
        reads: { where: { userId: req.userId } },
      },
    });
    if (!letter) return res.status(404).json({ error: 'Carta não encontrada.' });

    const isSender = letter.senderId === req.userId;
    const isRecipient = letter.recipientId === req.userId;
    if (!isSender && !isRecipient) {
      return res.status(403).json({ error: 'Sem acesso a esta carta.' });
    }

    const canRead = isSender || letter.status === 'entregue';

    res.json({
      id: letter.id,
      trackingCode: letter.trackingCode,
      sender: letter.sender,
      recipient: letter.recipient,
      recipientAddress: letter.recipientAddress,
      title: letter.title,
      kind: letter.kind,
      status: letter.status,
      sentAt: letter.sentAt,
      estimatedDelivery: letter.estimatedDelivery,
      deliveredAt: letter.deliveredAt,
      returnedAt: letter.returnedAt,
      failureReason: letter.failureReason,
      content: canRead ? letter.content : null,
      attachedImage: canRead ? letter.attachedImage : null, // <--- A CORREÇÃO ESTÁ AQUI
      canRead,
      read: letter.reads.length > 0,
      stamps: letter.stamps.map(ls => ({
        id: ls.stamp.id,
        name: ls.stamp.name,
        imagePath: ls.stamp.imagePath,
        quantity: ls.quantity,
      })),
      events: letter.events.map(ev => ({
        status: ev.status,
        message: ev.message,
        at: ev.createdAt,
      })),
    });
  } catch (e) { next(e); }
});

router.post('/:id/read', async (req, res, next) => {
  try {
    const letter = await prisma.letter.findUnique({ where: { id: req.params.id } });
    if (!letter) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    if (letter.recipientId !== req.userId) {
      return res.status(403).json({ error: 'Apenas o destinatário pode marcar como lida.' });
    }
    if (letter.status !== 'entregue') {
      return res.status(409).json({ error: 'A mensagem ainda não foi entregue.' });
    }
    await prisma.letterRead.upsert({
      where: { letterId_userId: { letterId: letter.id, userId: req.userId } },
      create: { letterId: letter.id, userId: req.userId },
      update: {},
    });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------
function serializeStamp(ls) {
  return {
    id: ls.stampId || ls.id,
    name: ls.name,
    imagePath: ls.imagePath,
    imageData: ls.imageData,
    isCustom: ls.isCustom,
    quantity: ls.quantity,
  };
}

function serializeSent(l) {
  return {
    id: l.id,
    trackingCode: l.trackingCode,
    to: l.recipientAddress,
    title: l.title,
    kind: l.kind,
    status: l.status,
    sentAt: l.sentAt,
    estimatedDelivery: l.estimatedDelivery,
    deliveredAt: l.deliveredAt,
    returnedAt: l.returnedAt,
    failureReason: l.failureReason,
    stamps: (l.stamps || []).map(serializeStamp),
  };
}

function serializeReceived(l) {
  return {
    id: l.id,
    fromUsername: l.sender.username,
    from: l.sender.displayAddress,
    title: l.title,
    kind: l.kind,
    status: l.status,
    deliveredAt: l.deliveredAt,
    read: l.reads.length > 0,
    stamps: (l.stamps || []).map(serializeStamp),
  };
}

export default router;
