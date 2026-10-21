import express from 'express';
import { migrate } from './db/index.js';
import { api } from './routes/api.js';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api', api);
app.use(express.static(new URL('../public', import.meta.url).pathname));
app.get('/healthz', (req, res) => res.send('ok'));

await migrate();
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Payroll simulator listening on ${port}`));
