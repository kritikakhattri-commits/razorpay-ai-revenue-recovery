'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_LINKS = [
  { label: 'Overview',       href: '/'        },
  { label: 'Recovery Cases', href: '/#cases'  },
  { label: 'Analytics',      href: '/#analytics' },
];

export function NavBar() {
  const pathname = usePathname();
  const isRoot = pathname === '/';

  return (
    <nav
      style={{ borderBottom: '1px solid #E5E5E3' }}
      className="bg-[#FCFCFA] sticky top-0 z-50"
    >
      <div className="max-w-[1400px] mx-auto px-6 flex items-center justify-between h-13">
        {/* Logo */}
        <div className="flex items-center gap-8">
          <Link
            href="/"
            className="flex items-center gap-2.5 shrink-0 group"
          >
            <span
              className="flex h-5 w-5 items-center justify-center text-white font-semibold text-[10px] select-none tracking-tight"
              style={{ backgroundColor: '#111111', borderRadius: 2 }}
            >
              R
            </span>
            <span className="text-[13px] font-medium text-neutral-900 tracking-tight select-none">
              Revenue Recovery
            </span>
          </Link>

          {/* Nav links */}
          <div className="flex items-center gap-0">
            {NAV_LINKS.map((link) => {
              const active =
                link.href === '/'
                  ? isRoot && typeof window !== 'undefined' &&
                    !window.location.hash.includes('cases') &&
                    !window.location.hash.includes('analytics')
                  : false;

              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`
                    px-4 py-2 text-[13px] transition-colors duration-150 relative
                    ${active
                      ? 'text-neutral-900 font-medium'
                      : 'text-neutral-400 hover:text-neutral-700 font-normal'
                    }
                  `}
                >
                  {link.label}
                  {active && (
                    <span
                      className="absolute bottom-0 left-4 right-4 h-px bg-neutral-900"
                    />
                  )}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Demo badge */}
        <span
          className="text-[11px] text-neutral-400 font-medium tracking-wide uppercase"
          style={{
            border: '1px solid #E0E0DE',
            padding: '3px 10px',
            borderRadius: 3,
            letterSpacing: '0.08em',
          }}
        >
          Demo
        </span>
      </div>
    </nav>
  );
}
