import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import config from './config.js';
import healthRouter from './routes/health.js';
import ocrRouter from './routes/ocr.js';
import errorHandler from './middleware/errorHandler.js';
import { scheduleCleanup } from './services/cleanup.js';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use('/health', healthRouter);
app.use('/v1/ocr', ocrRouter);

// Must be registered last — Express identifies error-handling middleware by
// its 4-argument arity.
app.use(errorHandler);

// Registered once at process startup (module-level execution, not inside a
// request handler) — schedules the daily retention cleanup job (PRD §3.3)
// without blocking server startup; cron.schedule() registers the job and
// returns immediately, it does not wait for the first trigger.
scheduleCleanup();

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`LensAPI listening on 0.0.0.0:${config.PORT}`);
});
