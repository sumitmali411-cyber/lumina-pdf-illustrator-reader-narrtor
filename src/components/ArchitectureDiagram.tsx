import React from 'react';
import { motion } from 'motion/react';

const ArchitectureDiagram: React.FC = () => {
  return (
    <div className="w-full aspect-[16/10] bg-zinc-900/50 rounded-xl p-6 border border-white/10 overflow-hidden relative">
      <svg viewBox="0 0 800 500" className="w-full h-full">
        {/* Connection Lines */}
        <motion.path
          d="M 150 250 L 300 150 M 150 250 L 300 350"
          stroke="rgba(255,255,255,0.2)"
          strokeWidth="2"
          fill="none"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1, delay: 0.5 }}
        />
        <motion.path
          d="M 450 150 L 600 250 M 450 350 L 600 250"
          stroke="rgba(255,255,255,0.2)"
          strokeWidth="2"
          fill="none"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1, delay: 1.5 }}
        />

        {/* Input Node */}
        <g transform="translate(50, 210)">
          <rect width="140" height="80" rx="12" fill="#27272a" stroke="#3f3f46" strokeWidth="2" />
          <text x="70" y="45" textAnchor="middle" fill="white" fontSize="14" fontWeight="bold">PDF Document</text>
          <text x="70" y="65" textAnchor="middle" fill="#71717a" fontSize="10">Text Extraction</text>
        </g>

        {/* Online Path */}
        <g transform="translate(300, 110)">
          <rect width="160" height="80" rx="12" fill="#581c87" stroke="#a855f7" strokeWidth="2" />
          <text x="80" y="45" textAnchor="middle" fill="white" fontSize="14" fontWeight="bold">AI Engine</text>
          <text x="80" y="65" textAnchor="middle" fill="#d8b4fe" fontSize="10">Gemini 3 + 2.5 Image</text>
          <circle cx="160" cy="0" r="4" fill="#a855f7">
            <animate attributeName="r" values="4;6;4" dur="2s" repeatCount="indefinite" />
          </circle>
        </g>

        {/* Offline Path */}
        <g transform="translate(300, 310)">
          <rect width="160" height="80" rx="12" fill="#18181b" stroke="#3f3f46" strokeWidth="2" />
          <text x="80" y="45" textAnchor="middle" fill="white" fontSize="14" fontWeight="bold">Offline Engine</text>
          <text x="80" y="65" textAnchor="middle" fill="#71717a" fontSize="10">Vanta.js + RoughJS</text>
        </g>

        {/* Output Node */}
        <g transform="translate(600, 210)">
          <rect width="150" height="80" rx="12" fill="#064e3b" stroke="#10b981" strokeWidth="2" />
          <text x="75" y="45" textAnchor="middle" fill="white" fontSize="14" fontWeight="bold">Lumina UI</text>
          <text x="75" y="65" textAnchor="middle" fill="#6ee7b7" fontSize="10">Illustrated Reader</text>
        </g>

        {/* Labels */}
        <text x="225" y="180" fill="#a855f7" fontSize="12" fontWeight="bold" transform="rotate(-30, 225, 180)">Quota Available</text>
        <text x="225" y="320" fill="#71717a" fontSize="12" fontWeight="bold" transform="rotate(30, 225, 320)">Offline Fallback</text>
      </svg>
      
      <div className="absolute bottom-4 left-6 right-6 flex justify-between text-[10px] uppercase tracking-widest text-zinc-500 font-bold">
        <span>Cloud Intelligence</span>
        <span>Local Generative Art</span>
      </div>
    </div>
  );
};

export default ArchitectureDiagram;
