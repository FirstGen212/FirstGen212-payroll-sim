// Employer portal API, mounted inside a workspace: /api/w/:ws/portal/...
import express from 'express';
import * as portal from '../services/portal.js';

export const portalRoutes = express.Router({ mergeParams: true });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => {
  if (!res.headersSent) res.json(out ?? { ok: true });
}).catch(next);

portalRoutes.get('/clients', wrap((req) => portal.listClients(req.ws)));
portalRoutes.get('/clients/:id', wrap((req) => portal.clientDetail(req.ws, Number(req.params.id))));
portalRoutes.patch('/clients/:id', wrap((req) => portal.updateClient(req.ws, Number(req.params.id), req.body)));
portalRoutes.post('/clients/:id/advance', wrap(async (req) => ({ status: await portal.advance(req.ws, Number(req.params.id)) })));
portalRoutes.post('/clients/:id/milestones/:name', wrap((req) => portal.setMilestone(req.ws, Number(req.params.id), req.params.name)));
portalRoutes.post('/clients/:id/price', wrap((req) => portal.priceRoster(req.ws, Number(req.params.id))));
portalRoutes.get('/clients/:id/audit', wrap((req) => portal.audit(req.ws, Number(req.params.id))));
portalRoutes.get('/clients/:id/mock-diagnosis', wrap((req) => portal.mockDiagnosis(req.ws, Number(req.params.id), req.query)));
portalRoutes.post('/clients/:id/employees/:num/products', wrap((req) => portal.setEmployeeProducts(req.ws, Number(req.params.id), req.params.num, req.body)));
portalRoutes.post('/clients/:id/good-to-launch', wrap((req) => portal.markGoodToLaunch(req.ws, Number(req.params.id))));
portalRoutes.get('/clients/:id/launch-files', wrap((req) => portal.launchFiles(req.ws, Number(req.params.id), req.query)));
portalRoutes.post('/clients/:id/launch-files/apply', wrap((req) => portal.applyLaunchFiles(req.ws, Number(req.params.id), req.body)));
portalRoutes.get('/clients/:id/recon', wrap((req) => portal.reconciliation(req.ws, Number(req.params.id))));
portalRoutes.post('/clients/:id/recon/open', wrap((req) => portal.openReconMonth(req.ws, Number(req.params.id), req.body.month)));
portalRoutes.post('/clients/:id/recon/action', wrap((req) => portal.reconAction(req.ws, Number(req.params.id), req.body)));

portalRoutes.get('/queues/:queue', wrap((req) => portal.listJobs(req.ws, req.params.queue)));
portalRoutes.get('/jobs/:id', wrap((req) => portal.jobDetail(req.ws, Number(req.params.id))));
portalRoutes.patch('/jobs/:id/rows/:index', wrap((req) => portal.updateJobRow(req.ws, Number(req.params.id), Number(req.params.index), req.body)));
portalRoutes.post('/jobs/:id/notes', wrap((req) => portal.addJobNote(req.ws, Number(req.params.id), req.body.text, req.user.name)));
portalRoutes.post('/jobs/:id/confirm', wrap((req) => portal.confirmJob(req.ws, Number(req.params.id))));
portalRoutes.post('/jobs/:id/push-back', wrap((req) => portal.pushBackJob(req.ws, Number(req.params.id), req.body.reason)));
portalRoutes.get('/jobs/:id/calculator', wrap((req) => portal.jobCalculator(req.ws, Number(req.params.id), {
  programPrice: Number(req.query.price) || 149,
  disabledRules: (req.query.disabled || '').split(',').filter(Boolean).map(Number),
})));
portalRoutes.post('/jobs/:id/proposal', wrap((req) => portal.saveProposal(req.ws, Number(req.params.id), req.body)));
portalRoutes.post('/jobs/:id/complete', wrap((req) => portal.completeJob(req.ws, Number(req.params.id))));

portalRoutes.get('/census-uploads', wrap((req) => portal.listCensusUploads(req.ws)));
portalRoutes.get('/census-uploads/:id', wrap((req) => portal.censusUpload(req.ws, Number(req.params.id))));
portalRoutes.put('/census-uploads/:id/rows', wrap((req) => portal.updateCensusRows(req.ws, Number(req.params.id), req.body.rows)));
portalRoutes.post('/census-uploads/:id/ask', wrap((req) => portal.askClient(req.ws, Number(req.params.id), req.body.employeeNumber, req.body.field)));
portalRoutes.post('/census-uploads/:id/send', wrap((req) => portal.sendCensus(req.ws, Number(req.params.id))));

portalRoutes.get('/activity', wrap((req) => portal.activity(req.ws, { companyId: Number(req.query.company) || null })));
