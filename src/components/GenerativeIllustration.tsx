import React, { useEffect, useRef } from 'react';
import rough from 'roughjs';

interface GenerativeIllustrationProps {
  seed: string;
}

const GenerativeIllustration: React.FC<GenerativeIllustrationProps> = ({ seed }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvasRef.current) {
      const canvas = canvasRef.current;
      const rc = rough.canvas(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Simple deterministic random based on seed
      const hash = seed.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const rand = (max: number) => (hash * 1337) % max;

      const color = `rgba(168, 85, 247, 0.3)`; // Purple theme
      
      // Draw some abstract "book/story" shapes
      rc.rectangle(20, 20, 160, 260, { 
        roughness: 2, 
        stroke: '#ffffff44', 
        strokeWidth: 1,
        fill: color,
        fillStyle: 'hachure'
      });

      rc.line(40, 60, 160, 60, { stroke: '#ffffff22' });
      rc.line(40, 80, 140, 80, { stroke: '#ffffff22' });
      rc.line(40, 100, 150, 100, { stroke: '#ffffff22' });

      // Abstract "sparkle" or "idea"
      rc.circle(100, 150, 40 + (hash % 20), {
        roughness: 1.5,
        stroke: '#a855f7',
        strokeWidth: 2,
        fill: 'rgba(168, 85, 247, 0.1)',
        fillStyle: 'solid'
      });

      rc.arc(100, 150, 80, 80, 0, Math.PI, true, {
        stroke: '#ffffff33',
        strokeWidth: 1
      });
    }
  }, [seed]);

  return (
    <canvas 
      ref={canvasRef} 
      width={200} 
      height={300} 
      className="opacity-40 grayscale-[0.3]"
    />
  );
};

export default GenerativeIllustration;
