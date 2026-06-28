'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';

interface BannerConfig {
  id: string;
  message: string;
  type: 'info' | 'warning' | 'success' | 'error';
  enabled: boolean;
  dismissible: boolean;
  linkText?: string;
  linkUrl?: string;
  expiresAt?: string;
}

export default function AdminBanner() {
  const [banner, setBanner] = useState<BannerConfig | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  // Handle hydration
  useEffect(() => {
    setMounted(true);
  }, []);

  // Hide banner on video player, live TV, details, about, and reverse-engineering pages
  const isHiddenPage =
    pathname?.startsWith('/watch') ||
    pathname?.startsWith('/livetv') ||
    pathname?.startsWith('/details') ||
    pathname?.startsWith('/about') ||
    pathname?.startsWith('/reverse-engineering');

  useEffect(() => {
    if (mounted) {
      fetchBanner();
    }
  }, [mounted]);

  // Check if banner should be dismissed - FORCE SHOW NEW IDs
  useEffect(() => {
    if (!banner || !mounted) return;
    
    const dismissedBannerId = localStorage.getItem('dismissedBannerId');
    
    // If this is a different banner ID, ALWAYS show it (new banner)
    if (dismissedBannerId !== banner.id) {
      setDismissed(false);
      return;
    }
    
    // Same banner ID - check if dismissal is still valid (24 hours)
    const dismissedAt = localStorage.getItem('bannerDismissedAt');
    if (dismissedAt) {
      const dismissedTime = new Date(dismissedAt).getTime();
      const now = Date.now();
      
      // Reset dismissal after 24 hours
      if (now - dismissedTime > 24 * 60 * 60 * 1000) {
        localStorage.removeItem('dismissedBannerId');
        localStorage.removeItem('bannerDismissedAt');
        setDismissed(false);
      } else {
        setDismissed(true);
      }
    } else {
      // No dismissal time stored, don't dismiss
      setDismissed(false);
    }
  }, [banner, mounted]);

  const fetchBanner = async () => {
    try {
      const response = await fetch('/api/admin/banner');
      const data = await response.json();
      
      if (data.success && data.data?.banner && data.data.banner.enabled) {
        // Check if banner has expired
        if (data.data.banner.expiresAt && new Date(data.data.banner.expiresAt) < new Date()) {
          setBanner(null);
          return;
        }
        setBanner(data.data.banner);
      } else {
        setBanner(null);
      }
    } catch (error) {
      console.error('Failed to fetch banner:', error);
      setBanner(null);
    } finally {
      setLoading(false);
    }
  };

  const handleDismiss = () => {
    if (!banner) return;
    setDismissed(true);
    // Store the specific banner ID that was dismissed
    localStorage.setItem('dismissedBannerId', banner.id);
    localStorage.setItem('bannerDismissedAt', new Date().toISOString());
  };

  // Don't render until mounted (prevents hydration mismatch)
  if (!mounted) {
    return null;
  }

  // Don't show on player/details pages or if dismissed/loading/no banner
  if (loading || !banner || dismissed || isHiddenPage) {
    return null;
  }

  const getBannerStyles = (type: string) => {
    const baseStyles = {
      position: 'fixed' as const,
      top: '72px',
      left: 0,
      right: 0,
      zIndex: 999,
      padding: '12px 60px 12px 24px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '14px',
      fontWeight: '500',
      animation: 'slideDown 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
      WebkitBackdropFilter: 'blur(12px)',
      backdropFilter: 'blur(12px)',
      borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
    };

    switch (type) {
      case 'warning':
        return {
          ...baseStyles,
          background: 'linear-gradient(90deg, rgba(245, 158, 11, 0.1) 0%, rgba(234, 88, 12, 0.15) 50%, rgba(245, 158, 11, 0.1) 100%)',
          borderBottomColor: 'rgba(245, 158, 11, 0.3)',
          color: '#fef3c7',
        };
      case 'error':
        return {
          ...baseStyles,
          background: 'linear-gradient(90deg, rgba(239, 68, 68, 0.1) 0%, rgba(220, 38, 38, 0.15) 50%, rgba(239, 68, 68, 0.1) 100%)',
          borderBottomColor: 'rgba(239, 68, 68, 0.3)',
          color: '#fee2e2',
        };
      case 'info':
        return {
          ...baseStyles,
          background: 'linear-gradient(90deg, rgba(139, 92, 246, 0.15) 0%, rgba(99, 102, 241, 0.2) 50%, rgba(139, 92, 246, 0.15) 100%)',
          borderBottomColor: 'rgba(139, 92, 246, 0.3)',
          color: '#e0e7ff',
        };
      case 'success':
      default:
        return {
          ...baseStyles,
          background: 'linear-gradient(90deg, rgba(16, 185, 129, 0.1) 0%, rgba(5, 150, 105, 0.15) 50%, rgba(16, 185, 129, 0.1) 100%)',
          borderBottomColor: 'rgba(16, 185, 129, 0.3)',
          color: '#d1fae5',
        };
    }
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'info': return 'ℹ️';
      case 'warning': return '⚠️';
      case 'success': return '✅';
      case 'error': return '🚨';
      default: return 'ℹ️';
    }
  };

  return (
    <>
      <style jsx>{`
        @keyframes slideDown {
          from {
            transform: translateY(-100%);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }
      `}</style>
      <div style={getBannerStyles(banner.type)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', maxWidth: '1400px', width: '100%', justifyContent: 'center' }}>
          <span style={{ 
            width: '28px', 
            height: '28px', 
            borderRadius: '8px', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            fontSize: '14px', 
            flexShrink: 0,
            background: 'linear-gradient(135deg, rgba(255,255,255,0.2), rgba(255,255,255,0.1))',
            boxShadow: '0 0 20px rgba(255,255,255,0.1)'
          }}>
            {getIcon(banner.type)}
          </span>
          <span style={{ textAlign: 'center', fontWeight: '500', letterSpacing: '0.01em', lineHeight: '1.4' }}>
            {banner.message}
          </span>
          {banner.linkText && banner.linkUrl && (
            <a 
              href={banner.linkUrl} 
              style={{
                color: 'inherit',
                textDecoration: 'none',
                fontWeight: '600',
                padding: '4px 12px',
                background: 'rgba(255, 255, 255, 0.1)',
                borderRadius: '6px',
                marginLeft: '8px',
                transition: 'all 0.2s ease',
                whiteSpace: 'nowrap'
              }}
              target={banner.linkUrl.startsWith('http') ? '_blank' : undefined}
              rel={banner.linkUrl.startsWith('http') ? 'noopener noreferrer' : undefined}
              onMouseOver={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              {banner.linkText} →
            </a>
          )}
        </div>
        {banner.dismissible && (
          <button 
            style={{
              position: 'absolute',
              right: '16px',
              background: 'rgba(255, 255, 255, 0.08)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              color: 'rgba(255, 255, 255, 0.6)',
              width: '28px',
              height: '28px',
              borderRadius: '8px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '14px',
              transition: 'all 0.2s ease'
            }}
            onClick={handleDismiss}
            onMouseOver={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
              e.currentTarget.style.color = 'white';
              e.currentTarget.style.transform = 'scale(1.05)';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
              e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)';
              e.currentTarget.style.transform = 'scale(1)';
            }}
            aria-label="Dismiss banner"
          >
            ✕
          </button>
        )}
      </div>
    </>
  );
}
