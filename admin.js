import { Router } from 'express';
import { prisma } from './prisma.js';
import { requireAuth } from './middleware.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';

const router = Router();

const requireAdmin = (req, res, next) => {
  if (req.username !== 'nathanlima') {
    return res.status(403).json({ error: 'ACESSO NEGADO. LOG DE SEGURANÇA REGISTRADO.' });
  }
  next();
};

router.use(requireAuth);
router.use(requireAdmin);

// ---------------------------------------------------------------
// GET /api/admin/users
// ---------------------------------------------------------------
router.get('/users', async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        displayAddress: true,
        status: true,
        createdAt: true,
        wallet: { select: { balance: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// POST /api/admin/execute
// ---------------------------------------------------------------
router.post('/execute', async (req, res, next) => {
  try {
    const { command } = z.object({ command: z.string() }).parse(req.body);

    // O comando é dividido por ponto: #comando.arg1.arg2
    const parts = command.trim().split('.');
    const action = parts[0];
    const arg1 = parts[1]; // Geralmente o username
    const arg2 = parts[2];
    const arg3 = parts[3];

    // ============================================================
    // 1. GEMAS
    // ============================================================
    if (action === '#addGema') {
      const amount = Number(arg2);
      if (!arg1 || isNaN(amount)) return res.status(400).json({ error: 'Sintaxe: #addGema.username.quantidade' });

      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { username: arg1 } });
        if (!user) throw new Error('Usuário não encontrado.');

        const updatedWallet = await tx.wallet.update({
          where: { userId: user.id },
          data: { balance: { increment: amount } },
        });

        await tx.walletTransaction.create({
          data: {
            userId: user.id,
            type: amount >= 0 ? 'credit' : 'debit',
            amount: Math.abs(amount),
            reason: `[ADMIN] Ajuste manual`,
            refType: 'admin_command',
          },
        });
        return updatedWallet.balance;
      });
      return res.json({ success: true, message: `Saldo de @${arg1} agora é ${result}.` });
    }

    // ============================================================
    // 2. BANIR
    // ============================================================
    if (action === '#addBan') {
      if (!arg1) return res.status(400).json({ error: 'Sintaxe: #addBan.username' });
      await prisma.user.update({ where: { username: arg1 }, data: { status: 'banned' } });
      return res.json({ success: true, message: `Usuário @${arg1} foi BANIDO.` });
    }

    // ============================================================
    // 3. REMOVER BANIMENTO (SUGESTÃO)
    // ============================================================
    if (action === '#unban') {
      if (!arg1) return res.status(400).json({ error: 'Sintaxe: #unban.username' });
      await prisma.user.update({ where: { username: arg1 }, data: { status: 'active' } });
      return res.json({ success: true, message: `Usuário @${arg1} foi DESBANIDO.` });
    }

    // ============================================================
    // 4. DELETAR USUÁRIO
    // ============================================================
    if (action === '#delUser') {
      if (!arg1) return res.status(400).json({ error: 'Sintaxe: #delUser.username' });
      await prisma.user.delete({ where: { username: arg1 } });
      return res.json({ success: true, message: `Usuário @${arg1} e todos os seus dados foram DELETADOS.` });
    }

    // ============================================================
    // 5. RESETAR SENHA
    // ============================================================
    if (action === '#resetUser') {
      if (!arg1) return res.status(400).json({ error: 'Sintaxe: #resetUser.username' });
      
      // Gera uma senha temporária (ex: k9F2mP)
      const newPassword = crypto.randomBytes(3).toString('hex');
      const passwordHash = await bcrypt.hash(newPassword, 12);

      await prisma.user.update({
        where: { username: arg1 },
        data: { passwordHash },
      });
      return res.json({ success: true, message: `Senha de @${arg1} resetada. Nova senha temporária: [ ${newPassword} ]` });
    }

    // ============================================================
    // 6. DELETAR CARTA (POR ID)
    // ============================================================
    if (action === '#delCarta') {
      if (!arg1) return res.status(400).json({ error: 'Sintaxe: #delCarta.id_da_carta' });
      await prisma.letter.delete({ where: { id: arg1 } });
      return res.json({ success: true, message: `Carta ID ${arg1} deletada do banco de dados.` });
    }

    // ============================================================
    // 7. DELETAR EXTRATO
    // ============================================================
    if (action === '#delEstr') {
      if (!arg1) return res.status(400).json({ error: 'Sintaxe: #delEstr.username' });
      const user = await prisma.user.findUnique({ where: { username: arg1 } });
      if (!user) throw new Error('Usuário não encontrado.');
      
      await prisma.walletTransaction.deleteMany({ where: { userId: user.id } });
      return res.json({ success: true, message: `Extrato de @${arg1} foi limpo.` });
    }

    // ============================================================
    // 8. VERIFICAR NOTIFICAÇÕES
    // ============================================================
    if (action === '#notiActive') {
      if (!arg1) return res.status(400).json({ error: 'Sintaxe: #notiActive.username' });
      const user = await prisma.user.findUnique({ 
        where: { username: arg1 },
        include: { pushSubscriptions: true } 
      });
      if (!user) throw new Error('Usuário não encontrado.');
      
      const active = user.pushSubscriptions.filter(s => s.active).length;
      return res.json({ 
        success: true, 
        message: `@${arg1} tem ${active} dispositivo(s) com notificações ativas.` 
      });
    }

    // ============================================================
    // 9. DAR SELO (SUGESTÃO)
    // ============================================================
    if (action === '#addSelo') {
      const stampId = arg2;
      const quantity = Number(arg3) || 1;
      
      if (!arg1 || !stampId) return res.status(400).json({ error: 'Sintaxe: #addSelo.username.id_do_selo.quantidade' });
      
      const user = await prisma.user.findUnique({ where: { username: arg1 } });
      if (!user) throw new Error('Usuário não encontrado.');
      
      const stamp = await prisma.stamp.findUnique({ where: { id: stampId } });
      if (!stamp) throw new Error('Selo não encontrado.');

      await prisma.userStamp.upsert({
        where: { userId_stampId_source: { userId: user.id, stampId: stamp.id, source: 'purchased' } },
        create: {
          userId: user.id, stampId: stamp.id, quantity: quantity, source: 'purchased',
          frozenName: stamp.name, frozenImagePath: stamp.imagePath, frozenImageData: stamp.imageData,
          frozenCategory: stamp.category, frozenIsCustom: stamp.isCustom,
        },
        update: { quantity: { increment: quantity } },
      });
      return res.json({ success: true, message: `${quantity}x ${stamp.name} adicionado(s) a @${arg1}.` });
    }

    // ============================================================
    // 10. CORRIGIR ENDEREÇO (SUGESTÃO)
    // ============================================================
    if (action === '#fixAddress') {
      // Sintaxe: #fixAddress.username.Rua.Numero.Cidade
      // Isso é mais complexo porque os endereços têm espaço. Vamos pegar tudo após o username.
      const rawArgs = command.split('.');
      const username = rawArgs[1];
      const street = rawArgs[2];
      const number = rawArgs[3];
      const city = rawArgs[4];

      if (!username || !street || !number || !city) {
        return res.status(400).json({ error: 'Sintaxe: #fixAddress.username.Rua.Numero.Cidade' });
      }

      // Precisamos importar o buildDisplayAddress do utils
      // Mas para simplificar, vamos fazer a concatenação manual igual o utils faz
      const displayAddress = `${street}, nº ${number} — ${city}`;

      const user = await prisma.user.findUnique({ where: { username } });
      if (!user) throw new Error('Usuário não encontrado.');

      await prisma.user.update({
        where: { username },
        data: { street, number, city, displayAddress }
      });

      return res.json({ success: true, message: `Endereço de @${username} atualizado para: ${displayAddress}` });
    }

    // ============================================================
    // 11. LIMPAR RASCUNHOS (SUGESTÃO)
    // ============================================================
    if (action === '#cleanDrafts') {
      if (!arg1) return res.status(400).json({ error: 'Sintaxe: #cleanDrafts.username' });
      
      const user = await prisma.user.findUnique({ where: { username: arg1 } });
      if (!user) throw new Error('Usuário não encontrado.');

      const result = await prisma.draft.deleteMany({ where: { userId: user.id } });
      return res.json({ success: true, message: `${result.count} rascunho(s) de @${arg1} deletado(s).` });
    }

    // ============================================================
    // COMANDO DESCONHECIDO
    // ============================================================
    return res.status(400).json({ error: 'Comando desconhecido.' });

  } catch (e) { 
    if (e.message === 'Usuário não encontrado.') return res.status(404).json({ error: e.message });
    if (e.message === 'Selo não encontrado.') return res.status(404).json({ error: e.message });
    if (e.code === 'P2025') return res.status(404).json({ error: 'Registro não encontrado no banco.' });
    next(e); 
  }
});

export default router;
