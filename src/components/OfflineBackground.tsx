import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
// @ts-ignore
import FOG from 'vanta/dist/vanta.fog.min';

interface OfflineBackgroundProps {
  color?: number;
  highlightColor?: number;
  midtoneColor?: number;
  lowlightColor?: number;
  baseColor?: number;
}

const OfflineBackground: React.FC<OfflineBackgroundProps> = ({
  color = 0x1a1a1a,
  highlightColor = 0x4c1d95,
  midtoneColor = 0x1e1b4b,
  lowlightColor = 0x0f172a,
  baseColor = 0x020617
}) => {
  const [vantaEffect, setVantaEffect] = useState<any>(null);
  const myRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!vantaEffect && myRef.current) {
      setVantaEffect(
        FOG({
          el: myRef.current,
          THREE: THREE,
          mouseControls: true,
          touchControls: true,
          gyroControls: false,
          minHeight: 200.00,
          minWidth: 200.00,
          highlightColor: highlightColor,
          midtoneColor: midtoneColor,
          lowlightColor: lowlightColor,
          baseColor: baseColor,
          blurFactor: 0.6,
          speed: 1.5,
          zoom: 0.5
        })
      );
    }
    return () => {
      if (vantaEffect) vantaEffect.destroy();
    };
  }, [vantaEffect]);

  return (
    <div 
      ref={myRef} 
      className="fixed inset-0 w-full h-full -z-10 opacity-40 grayscale-[0.5]" 
    />
  );
};

export default OfflineBackground;
