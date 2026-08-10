'use strict';const{Router}=require('express');const{requireAuth,requireRoles}=require('../application/auth.service');const f=require('../application/fleet.service');const r=Router();const run=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(e=>res.status(e.statusCode||500).json({error:e.statusCode?e.message:'Erro interno do servidor.'}));
// Catálogo de modais (§ 3.33) antes do portão de ADMIN: é vocabulário, não
// dados da empresa, e os ecrãs de tarifação (ADMIN/SUPPORT) também o precisam
// para não voltarem a escrever a tabela de capacidades à mão.
r.get('/modals',requireAuth,run(async(_q,res)=>res.json(f.listModals())));
r.use(requireAuth,requireRoles(['ADMIN']));r.get('/stats',run(async(_q,res)=>res.json(await f.getStats())));r.get('/vehicles',run(async(_q,res)=>res.json(await f.listVehicles())));r.post('/vehicles',run(async(req,res)=>res.status(201).json(await f.createVehicle(req.body))));r.get('/fuel',run(async(req,res)=>res.json(await f.listFuel(req.query.vehicleId))));r.post('/fuel',run(async(req,res)=>res.status(201).json(await f.createFuel(req.body,req.user?.sub))));module.exports=r;
