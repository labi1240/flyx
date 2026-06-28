'use client';

import { ReactNode, useState, useEffect } from 'react';
import { Menu, X } from 'lucide-react';

interface ResponsiveLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
}

export default function ResponsiveLayout({ sidebar, children }: ResponsiveLayoutProps) {
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const checkScreenSize = () => {
      setIsMobile(window.innerWidth < 768);
      if (window.innerWidth >= 768) {
        setSidebarOpen(false); // Close mobile sidebar on desktop
      }
    };

    checkScreenSize();
    window.addEventListener('resize', checkScreenSize);
    return () => window.removeEventListener('resize', checkScreenSize);
  }, []);

  return (
    <div style={{
      display: 'flex',
      minHeight: '100vh',
      background: '#0f172a',
      color: '#f8fafc'
    }}>
      {/* Mobile Menu Button */}
      {isMobile && (
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          style={{
            position: 'fixed',
            top: '16px',
            left: '16px',
            zIndex: 60,
            padding: '12px',
            background: 'rgba(15, 23, 42, 0.9)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '8px',
            color: '#f8fafc',
            cursor: 'pointer',
            WebkitBackdropFilter: 'blur(10px)',
            backdropFilter: 'blur(10px)',
          }}
          aria-label={sidebarOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={sidebarOpen}
        >
          {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      )}

      {/* Sidebar */}
      <div
        style={{
          position: isMobile ? 'fixed' : 'fixed',
          left: isMobile ? (sidebarOpen ? '0' : '-260px') : '0',
          top: 0,
          width: '260px',
          height: '100vh',
          zIndex: 50,
          transition: 'left 0.3s ease-in-out',
          transform: isMobile && !sidebarOpen ? 'translateX(-100%)' : 'translateX(0)',
        }}
      >
        {sidebar}
      </div>

      {/* Mobile Overlay */}
      {isMobile && sidebarOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            zIndex: 40,
          }}
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Main Content */}
      <div
        style={{
          flex: 1,
          marginLeft: isMobile ? '0' : '260px',
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0, // Prevent flex item from overflowing
        }}
      >
        {children}
      </div>
    </div>
  );
}