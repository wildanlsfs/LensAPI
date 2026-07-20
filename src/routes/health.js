import { Router } from 'express';

const router = Router();

// GET /health — liveness only (process up).
router.get('/', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

export default router;
