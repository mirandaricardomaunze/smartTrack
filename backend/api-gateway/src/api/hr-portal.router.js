'use strict';const{Router}=require('express');const{requireAuth,requireRoles}=require('../application/auth.service');const portal=require('../application/hr-portal.service');const router=Router();const run=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(e=>{if(!e||!e.statusCode)console.error(`[hr-portal.router] Erro inesperado:`,e);return res.status(e?.statusCode||500).json({error:e?.statusCode?e.message:'Erro interno do servidor.'});});
router.post('/accounts',requireAuth,requireRoles(['ADMIN']),run(async(req,res)=>res.status(201).json(await portal.provision(req.body))));
router.get('/me',requireAuth,requireRoles(['EMPLOYEE']),run(async(req,res)=>res.json(await portal.dashboard(req.user.sub))));
router.post('/me/leaves',requireAuth,requireRoles(['EMPLOYEE']),run(async(req,res)=>res.status(201).json(await portal.requestLeave(req.user.sub,req.body))));
module.exports=router;
