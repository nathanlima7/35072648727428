import { Router } from 'express';
import { prisma } from './prisma.js';
import { requireAuth } from './middleware.js';
import { z } from 'zod';

const router = Router();

const requireAdmin = (req, res, next) => {
  if (req.username !== 'nathanlima') {
    return res.status(403).json({ error: 'ACESSO NEGADO. LOG DE SEGURANÇA REGISTRADO.' });
  }
  next();
};

router.use(requireAuth);
router.use(requireAdmin);

router.get('/users', async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        displayAddress: true,
        createdAt: true,
        wallet: { select: { balance: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users);
  } catch (e) { next(e); }
});

router.post('/execute', async (req, res, next) => {
  try {
    const { command } = z.object({ command: z.string() }).parse(req.body);

    // AQUI ESTÁ A MUDANÇA: agora o comando é dividido por ponto (.)
    // Exemplo: #adm.give.bea.500
    const parts = command.trim().split('.');
    const action = parts[0];

    // COMANDO 1: Dar/Remover Gemas
    // Uso: #adm.give.<username>.<quantidade>
    if (action === '#adm') {
      const subAction = parts[1];
      
      if (subAction === 'give') {
        const username = parts[2];
        const amount = Number(parts[3]);

        if (!username || isNaN(amount)) {
          return res.status(400).json({ error: 'Sintaxe: #adm.give.username.quantidade' });
        }

        const result = await prisma.$transaction(async (tx) => {
          const user = await tx.user.findUnique({ where: { username } });
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

        return res.json({ success: true, message: `Saldo de @${username} agora é ${result}.` });
      }
    }

    // NOVOS COMANDOS ENTRAM AQUI EMBAIXO:
    // Exemplo: #banir.hacker (aqui usaríamos if (action === '#banir'))
    // Exemplo: #reset.senha.bea

    return res.status(400).json({ error: 'Comando desconhecido.' });

  } catch (e) { 
    if (e.message === 'Usuário não encontrado.') return res.status(404).json({ error: e.message });
    next(e); 
  }
});

export default router;