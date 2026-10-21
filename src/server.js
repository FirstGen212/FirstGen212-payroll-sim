import express from 'express';
import { migrate } from './db/index.js';
import { api } from './routes/api.js';

const app = express();
// Render terminates TLS in front of the app; trust it so secure cookies work.
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use('/api', api);
app.use(express.static(new URL('../public', import.meta.url).pathname));
app.get('/portal', (req, res) => res.sendFile(new URL('../public/portal.html', import.meta.url).pathname));
app.get('/healthz', (req, res) => res.send('ok'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Payroll simulator listening on ${port}`));

// A new Render database can take a few minutes to accept connections; keep trying.
for (let attempt = 1; ; attempt++) {
  try {
    await migrate();
    break;
  } catch (err) {
    if (attempt >= 30) throw err;
    console.log(`Database not ready (${err.code || err.message}), retrying in 10s [${attempt}/30]`);
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}

