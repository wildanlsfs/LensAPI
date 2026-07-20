import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import config from './config.js';
import healthRouter from './routes/health.js';
import ocrRouter from './routes/ocr.js';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use('/health', healthRouter);
app.use('/v1/ocr', ocrRouter);

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`LensAPI listening on 0.0.0.0:${config.PORT}`);
});
