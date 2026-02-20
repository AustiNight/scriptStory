import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
}

const Visualizer: React.FC<VisualizerProps> = ({ isActive }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      if (!isActive) {
        // Idle state: straight line
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.stroke();
      } else {
        // Active state: Sine waves
        const time = Date.now() * 0.005;
        
        // Wave 1
        ctx.beginPath();
        for (let x = 0; x < w; x++) {
          const y = h / 2 + Math.sin(x * 0.05 + time) * 15 * Math.sin(time * 0.5);
          ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#3b82f6'; // Blue
        ctx.lineWidth = 2;
        ctx.stroke();

        // Wave 2
        ctx.beginPath();
        for (let x = 0; x < w; x++) {
          const y = h / 2 + Math.sin(x * 0.03 - time) * 10;
          ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#8b5cf6'; // Purple
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => cancelAnimationFrame(animationRef.current);
  }, [isActive]);

  return (
    <div className="w-64 h-16 bg-black/20 backdrop-blur-md rounded-full border border-white/10 flex items-center justify-center overflow-hidden shadow-lg">
      <canvas ref={canvasRef} width={256} height={64} className="w-full h-full" />
    </div>
  );
};

export default Visualizer;