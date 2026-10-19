import { Router } from 'express';
import { prisma } from './prisma.js';
import { requireAuth } from './middleware.js';

const router = Router();

// Consulta pública por código
router.get('/:code', async (req, res, next) => {
  try {
    const letter = await prisma.letter.findUnique({
      where: { trackingCode: req.params.code },
      include: {
        sender: { select: { displayAddress: true } },
        recipient: { select: { displayAddress: true } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!letter) return res.status(404).json({ error: 'Código não encontrado.' });
    
    // Bloqueia consulta de telegrama no rastreio público
    if (letter.kind === 'telegram') {
      return res.status(400).json({ error: 'Telegramas não possuem rastreamento.' });
    }

    res.json({
      trackingCode: letter.trackingCode,
      from: letter.sender.displayAddress,
      to: letter.recipientAddress,
      status: letter.status,
      sentAt: letter.sentAt,
      estimatedDelivery: letter.estimatedDelivery,
      deliveredAt: letter.deliveredAt,
      returnedAt: letter.returnedAt,
      failureReason: letter.failureReason,
      title: letter.title,
      events: letter.events.map((ev) => ({
        status: ev.status,
        message: ev.message,
        at: ev.createdAt,
      })),
    });
  } catch (e) { next(e); }
});

// Lista de cartas enviadas pelo usuário logado (usada na tela de rastreio)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const letters = await prisma.letter.findMany({
      where: { 
        senderId: req.userId,
        kind: 'letter' // ← Filtra aqui para nunca enviar telegramas pro frontend de rastreio
      },
      orderBy: { sentAt: 'desc' },
      include: {
        events: { orderBy: { createdAt: 'asc' } },
      },
    });

    res.json(letters.map((l) => ({
      id: l.id,
      trackingCode: l.trackingCode,
      to: l.recipientAddress,
      title: l.title,
      status: l.status,
      sentAt: l.sentAt,
      estimatedDelivery: l.estimatedDelivery,
      deliveredAt: l.deliveredAt,
      returnedAt: l.returnedAt,
      lastEvent: l.events[l.events.length - 1] || null,
    })));
  } catch (e) { next(e); }
});

export default router;