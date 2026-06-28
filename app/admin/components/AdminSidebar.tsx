'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSecurity } from './SecurityProvider';
import {
    LayoutDashboard,
    Users,
    Film,
    Settings,
    LogOut,
    Globe,
    Activity,
    Radio,
} from 'lucide-react';

export default function AdminSidebar() {
    const pathname = usePathname();
    const { logout } = useSecurity();
    const [isSigningOut, setIsSigningOut] = useState(false);

    const handleSignOut = async () => {
        if (isSigningOut) return; // Prevent double-click
        
        setIsSigningOut(true);
        try {
            // Clear any stored redirect destination
            sessionStorage.removeItem('admin_redirect_after_login');
            
            // Call logout API
            await logout();
            
            // Clear any local storage items related to admin
            localStorage.removeItem('admin_preferences');
            
            // Redirect to admin login page
            window.location.href = '/admin';
        } catch (error) {
            console.error('Sign out error:', error);
            // Force redirect even if logout fails
            window.location.href = '/admin';
        } finally {
            setIsSigningOut(false);
        }
    };

    const menuItems = [
        { icon: LayoutDashboard, label: 'Dashboard', href: '/admin/dashboard' },
        { icon: Radio, label: 'Live Stats', href: '/admin/live-stats' },
        { icon: Film, label: 'Content', href: '/admin/content' },
        { icon: Users, label: 'Users', href: '/admin/users' },
        { icon: Globe, label: 'Geographic', href: '/admin/geographic' },
        { icon: Activity, label: 'System Health', href: '/admin/system-health' },
        { icon: Settings, label: 'Settings', href: '/admin/settings' },
    ];

    // Check if current path matches or starts with the menu item href
    const isActive = (href: string) => {
        if (pathname === href) return true;
        // /admin root redirects to dashboard
        if (href === '/admin/dashboard' && pathname === '/admin') return true;
        // For nested routes, check if pathname starts with href
        if (pathname?.startsWith(href + '/')) return true;
        return false;
    };

    return (
        <aside 
            style={{
                width: '260px',
                height: '100vh',
                background: 'rgba(15, 23, 42, 0.6)',
                borderRight: '1px solid rgba(255, 255, 255, 0.1)',
                display: 'flex',
                flexDirection: 'column',
                padding: '24px',
                WebkitBackdropFilter: 'blur(20px)',
                backdropFilter: 'blur(20px)',
                position: 'relative',
                zIndex: 50
            }}
            role="navigation"
            aria-label="Admin panel navigation"
        >
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                marginBottom: '40px',
                padding: '0 12px'
            }}>
                <div 
                    style={{
                        width: '32px',
                        height: '32px',
                        background: 'linear-gradient(135deg, #7877c6 0%, #9333ea 100%)',
                        borderRadius: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 'bold',
                        color: 'white'
                    }}
                    aria-hidden="true"
                >
                    F
                </div>
                <span style={{ fontSize: '20px', fontWeight: '700', color: '#f8fafc' }}>
                    Flyx Admin
                </span>
            </div>

            <nav 
                style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto' }}
                role="menubar"
                aria-label="Main navigation menu"
            >
                {menuItems.map((item) => {
                    const active = isActive(item.href);
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            role="menuitem"
                            aria-current={active ? 'page' : undefined}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '12px',
                                padding: '12px 16px',
                                borderRadius: '12px',
                                color: active ? '#fff' : '#94a3b8',
                                background: active ? 'rgba(120, 119, 198, 0.2)' : 'transparent',
                                textDecoration: 'none',
                                fontSize: '14px',
                                fontWeight: active ? '600' : '500',
                                transition: 'all 0.2s ease',
                                minHeight: '44px', // Minimum touch target
                                outline: 'none',
                                borderLeft: active ? '3px solid #7877c6' : '3px solid transparent',
                            }}
                            onMouseEnter={(e) => {
                                if (!active) {
                                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                                    e.currentTarget.style.color = '#e2e8f0';
                                }
                            }}
                            onMouseLeave={(e) => {
                                if (!active) {
                                    e.currentTarget.style.background = 'transparent';
                                    e.currentTarget.style.color = '#94a3b8';
                                }
                            }}
                            onFocus={(e) => {
                                e.currentTarget.style.outline = '2px solid #7877c6';
                                e.currentTarget.style.outlineOffset = '2px';
                            }}
                            onBlur={(e) => {
                                e.currentTarget.style.outline = 'none';
                            }}
                        >
                            <item.icon 
                                size={20} 
                                color={active ? '#fff' : '#94a3b8'} 
                                aria-hidden="true"
                            />
                            {item.label}
                        </Link>
                    );
                })}
            </nav>

            <button 
                onClick={handleSignOut}
                disabled={isSigningOut}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '12px',
                    padding: '12px 16px',
                    borderRadius: '12px',
                    color: isSigningOut ? '#94a3b8' : '#ef4444',
                    background: isSigningOut ? 'rgba(148, 163, 184, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                    border: 'none',
                    fontSize: '14px',
                    fontWeight: '500',
                    cursor: isSigningOut ? 'not-allowed' : 'pointer',
                    marginTop: 'auto',
                    minHeight: '44px', // Minimum touch target
                    outline: 'none',
                    transition: 'all 0.2s ease',
                    opacity: isSigningOut ? 0.7 : 1,
                }}
                onMouseEnter={(e) => {
                    if (!isSigningOut) {
                        e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)';
                    }
                }}
                onMouseLeave={(e) => {
                    if (!isSigningOut) {
                        e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
                    }
                }}
                onFocus={(e) => {
                    e.currentTarget.style.outline = '2px solid #ef4444';
                    e.currentTarget.style.outlineOffset = '2px';
                }}
                onBlur={(e) => {
                    e.currentTarget.style.outline = 'none';
                }}
                aria-label={isSigningOut ? 'Signing out...' : 'Sign out of admin panel'}
            >
                {isSigningOut ? (
                    <>
                        <div style={{
                            width: '20px',
                            height: '20px',
                            border: '2px solid rgba(148, 163, 184, 0.3)',
                            borderTopColor: '#94a3b8',
                            borderRadius: '50%',
                            animation: 'spin 1s linear infinite'
                        }} />
                        Signing Out...
                    </>
                ) : (
                    <>
                        <LogOut size={20} aria-hidden="true" />
                        Sign Out
                    </>
                )}
            </button>
            
            <style jsx>{`
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
            `}</style>
        </aside>
    );
}
