'use client';

import React from 'react';

export default function HubPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 font-sans">
      {/* Background visual effects */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-indigo-600/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-1/4 left-1/3 w-[300px] h-[300px] bg-emerald-600/5 blur-[100px] rounded-full pointer-events-none" />

      <div className="w-full max-w-4xl flex flex-col gap-10 items-center z-10">
        {/* Header */}
        <div className="text-center flex flex-col gap-3">
          <div className="inline-flex self-center w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-600 to-indigo-400 items-center justify-center shadow-[0_4px_20px_rgba(99,102,241,0.4)]">
            <svg className="w-7 h-7 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v3"/>
              <rect x="9" y="11" width="14" height="10" rx="2"/>
              <circle cx="12" cy="20" r="1"/><circle cx="20" cy="20" r="1"/>
            </svg>
          </div>
          <div>
            <h1 className="text-4xl font-extrabold tracking-tight text-white">SmartTrack</h1>
            <p className="text-slate-400 text-sm mt-2">Plataforma Unificada de Gestão e Rastreamento de Entregas</p>
          </div>
        </div>

        {/* Portal cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full mt-4">
          
          {/* Card 1: Admin */}
          <a 
            href="/login" 
            className="group relative bg-slate-900 border border-slate-800 rounded-2xl p-6 hover:border-indigo-500/50 hover:shadow-[0_0_30px_rgba(99,102,241,0.15)] transition-all duration-300 flex flex-col justify-between"
          >
            <div>
              <div className="w-10 h-10 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center mb-4 group-hover:bg-indigo-600 group-hover:text-white transition-colors duration-300">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18M15 3v18" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-slate-100 group-hover:text-indigo-400 transition-colors duration-200">Painel Operacional</h2>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                Gestão de encomendas, triagem em armazém, atribuição de motoristas e otimização inteligente de rotas.
              </p>
            </div>
            <div className="mt-8 flex items-center text-xs font-semibold text-indigo-400 group-hover:translate-x-1 transition-transform duration-200">
              Acessar Painel &rarr;
            </div>
          </a>

          {/* Card 2: Cliente */}
          <a 
            href="http://localhost:3011" 
            className="group relative bg-slate-900 border border-slate-800 rounded-2xl p-6 hover:border-brand-500/50 hover:shadow-[0_0_30px_rgba(99,102,241,0.15)] transition-all duration-300 flex flex-col justify-between"
          >
            <div>
              <div className="w-10 h-10 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center mb-4 group-hover:bg-indigo-600 group-hover:text-white transition-colors duration-300">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-slate-100 group-hover:text-indigo-400 transition-colors duration-200">Portal do Cliente</h2>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                Rastreamento simplificado em tempo real e timeline de movimentações nacionais e internacionais.
              </p>
            </div>
            <div className="mt-8 flex items-center text-xs font-semibold text-indigo-400 group-hover:translate-x-1 transition-transform duration-200">
              Rastrear Pacote &rarr;
            </div>
          </a>

          {/* Card 3: Motorista */}
          <a 
            href="http://localhost:3012" 
            className="group relative bg-slate-900 border border-slate-800 rounded-2xl p-6 hover:border-emerald-500/50 hover:shadow-[0_0_30px_rgba(16,185,129,0.15)] transition-all duration-300 flex flex-col justify-between"
          >
            <div>
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center mb-4 group-hover:bg-emerald-600 group-hover:text-white transition-colors duration-300">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-slate-100 group-hover:text-emerald-400 transition-colors duration-200">App do Motorista</h2>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                Visualização de rotas diárias, geolocalização e sincronização offline com suporte a IndexedDB.
              </p>
            </div>
            <div className="mt-8 flex items-center text-xs font-semibold text-emerald-400 group-hover:translate-x-1 transition-transform duration-200">
              Iniciar Entregas &rarr;
            </div>
          </a>

        </div>

        {/* Footer info */}
        <div className="text-slate-600 text-xs mt-4">
          SmartTrack Monorepo Hub &bull; Desenvolvido com Next.js &amp; Tailwind CSS
        </div>
      </div>
    </div>
  );
}
