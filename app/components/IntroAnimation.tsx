'use client';

import { useEffect, useRef, useState } from 'react';

type Phase = 'idle' | 'text1' | 'object' | 'text2' | 'shift' | 'exit' | 'done';

function MetallicLoop({
  visible,
  shifted,
}: {
  visible: boolean;
  shifted: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: 260,
        height: 260,
        flexShrink: 0,
        opacity: visible ? 1 : 0,
        transform: shifted
          ? 'translateX(48px) scale(0.9) rotate(3deg)'
          : 'translateX(0) scale(1) rotate(0deg)',
        transition:
          'opacity 1.4s cubic-bezier(0.16,1,0.3,1), transform 1s cubic-bezier(0.16,1,0.3,1)',
        filter: 'drop-shadow(0 12px 28px rgba(0,0,0,0.06))',
      }}
    >
      <svg
        viewBox="0 0 260 260"
        width="260"
        height="260"
        style={{ overflow: 'visible' }}
      >
        <defs>
          <linearGradient id="intro-mg1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   stopColor="#D4D4D0" />
            <stop offset="20%"  stopColor="#ABABAB" />
            <stop offset="50%"  stopColor="#ECECEA" />
            <stop offset="80%"  stopColor="#B8B8B6" />
            <stop offset="100%" stopColor="#D0D0CD" />
          </linearGradient>
          <linearGradient id="intro-mg2" x1="100%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"   stopColor="#C0C0BC" />
            <stop offset="35%"  stopColor="#F2F2EE" />
            <stop offset="65%"  stopColor="#ACACAA" />
            <stop offset="100%" stopColor="#D8D8D4" />
          </linearGradient>
          <linearGradient id="intro-mg3" x1="50%" y1="0%" x2="50%" y2="100%">
            <stop offset="0%"   stopColor="#E0E0DC" />
            <stop offset="50%"  stopColor="#9C9C9A" />
            <stop offset="100%" stopColor="#E0E0DC" />
          </linearGradient>
        </defs>

        {/* Outer horizontal ring */}
        <ellipse
          cx="130" cy="130" rx="108" ry="54"
          fill="none"
          stroke="url(#intro-mg1)"
          strokeWidth="22"
          className="rl-spin1"
        />

        {/* Inner angled ring */}
        <ellipse
          cx="130" cy="130" rx="60" ry="106"
          fill="none"
          stroke="url(#intro-mg2)"
          strokeWidth="18"
          className="rl-spin2"
          style={{ transform: 'rotate(22deg)' }}
        />

        {/* Center core */}
        <circle
          cx="130" cy="130" r="7"
          fill="url(#intro-mg3)"
          className="rl-pulse"
        />
      </svg>
    </div>
  );
}

export function IntroAnimation() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [mounted, setMounted] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    setMounted(true);

    // Skip if already seen this session
    if (sessionStorage.getItem('rr_intro_seen')) {
      setPhase('done');
      return;
    }
    sessionStorage.setItem('rr_intro_seen', '1');

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reducedMotion) {
      // Brief fade only
      setPhase('object');
      const t = setTimeout(() => setPhase('done'), 700);
      timers.current.push(t);
      return;
    }

    const schedule = (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      timers.current.push(t);
    };

    schedule(() => setPhase('text1'),  100);
    schedule(() => setPhase('object'), 420);
    schedule(() => setPhase('text2'), 1620);
    schedule(() => setPhase('shift'), 2350);
    schedule(() => setPhase('exit'),  3100);
    schedule(() => setPhase('done'),  3900);

    return () => timers.current.forEach(clearTimeout);
  }, []);

  if (!mounted || phase === 'done') return null;

  const isExit   = phase === 'exit';
  const showText1  = phase !== 'idle';
  const showObject = ['object', 'text2', 'shift', 'exit'].includes(phase);
  const showText2  = ['text2', 'shift', 'exit'].includes(phase);
  const isShifted  = ['shift', 'exit'].includes(phase);

  return (
    <div
      role="presentation"
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        backgroundColor: '#FCFCFA',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: isExit ? 0 : 1,
        transition: isExit
          ? 'opacity 700ms ease-in-out'
          : 'opacity 250ms ease-out',
        pointerEvents: isExit ? 'none' : 'all',
      }}
    >
      {/* Layout: text left + object right on wider viewports, stacked on mobile */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '36px',
          maxWidth: 600,
          padding: '0 32px',
          textAlign: 'center',
        }}
      >
        {/* Eyebrow */}
        <p
          style={{
            fontFamily: 'inherit',
            fontSize: '10px',
            fontWeight: 500,
            letterSpacing: '0.46em',
            color: '#AEAEAE',
            textTransform: 'uppercase',
            opacity: showText1 ? 1 : 0,
            transform: showText1 ? 'translateY(0)' : 'translateY(10px)',
            transition: 'opacity 900ms ease-out, transform 900ms ease-out',
            userSelect: 'none',
          }}
        >
          Revenue Recovery
        </p>

        {/* Metallic loop object */}
        <MetallicLoop visible={showObject} shifted={isShifted} />

        {/* Main text block */}
        <div
          style={{
            opacity: showText2 ? 1 : 0,
            transform: showText2 ? 'translateY(0)' : 'translateY(16px)',
            transition:
              'opacity 700ms cubic-bezier(0.16,1,0.3,1), transform 700ms cubic-bezier(0.16,1,0.3,1)',
          }}
        >
          <p
            style={{
              fontFamily: 'inherit',
              fontSize: '12px',
              fontWeight: 500,
              letterSpacing: '0.28em',
              color: '#2A2A2A',
              textTransform: 'uppercase',
              marginBottom: '12px',
              userSelect: 'none',
            }}
          >
            AI-Powered Revenue Intelligence
          </p>
          <p
            style={{
              fontFamily: 'inherit',
              fontSize: '15px',
              fontWeight: 300,
              color: '#888888',
              letterSpacing: '0.02em',
              lineHeight: 1.6,
              userSelect: 'none',
            }}
          >
            Recover what would otherwise be lost.
          </p>
        </div>
      </div>
    </div>
  );
}
