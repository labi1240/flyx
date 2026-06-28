'use client';

import { useState } from 'react';
import { useAnalytics } from '../../components/analytics/AnalyticsProvider';

interface AdminLoginProps {
    onLoginSuccess: (user: any) => void;
}

export default function AdminLogin({ onLoginSuccess }: AdminLoginProps) {
    const { trackEvent } = useAnalytics();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [loginLoading, setLoginLoading] = useState(false);
    const [error, setError] = useState('');

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoginLoading(true);
        setError('');

        try {
            const response = await fetch('/api/admin/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });

            const data = await response.json();

            if (response.ok) {
                // Track successful login
                trackEvent('admin_login', {
                    username: data.user.username,
                    timestamp: Date.now()
                });

                onLoginSuccess(data.user);
            } else {
                setError(data.error || 'Login failed');

                // Track failed login attempt
                trackEvent('admin_login_failed', {
                    username: username,
                    error: data.error,
                    timestamp: Date.now()
                });
            }
        } catch (err) {
            setError('Network error. Please try again.');
        } finally {
            setLoginLoading(false);
        }
    };

    return (
        <div style={{
            minHeight: '100vh',
            background: 'linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '20px',
            position: 'relative',
            overflow: 'hidden'
        }}>
            {/* Animated background elements */}
            <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: `
          radial-gradient(circle at 20% 80%, rgba(120, 119, 198, 0.4) 0%, transparent 50%),
          radial-gradient(circle at 80% 20%, rgba(255, 119, 198, 0.2) 0%, transparent 50%),
          radial-gradient(circle at 40% 40%, rgba(120, 219, 255, 0.15) 0%, transparent 50%)
        `
            }}></div>

            {/* Floating particles */}
            <div style={{
                position: 'absolute',
                top: '10%',
                left: '10%',
                width: '4px',
                height: '4px',
                background: '#7877c6',
                borderRadius: '50%',
                animation: 'float 6s ease-in-out infinite',
                opacity: 0.6
            }}></div>
            <div style={{
                position: 'absolute',
                top: '20%',
                right: '15%',
                width: '6px',
                height: '6px',
                background: '#ff77c6',
                borderRadius: '50%',
                animation: 'float 8s ease-in-out infinite reverse',
                opacity: 0.4
            }}></div>
            <div style={{
                position: 'absolute',
                bottom: '15%',
                left: '20%',
                width: '3px',
                height: '3px',
                background: '#78dbff',
                borderRadius: '50%',
                animation: 'float 7s ease-in-out infinite',
                opacity: 0.5
            }}></div>

            <div style={{
                background: 'rgba(15, 15, 35, 0.95)',
                padding: '48px',
                borderRadius: '24px',
                boxShadow: '0 25px 50px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.1)',
                width: '100%',
                maxWidth: '420px',
                WebkitBackdropFilter: 'blur(20px)',
                backdropFilter: 'blur(20px)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                position: 'relative',
                zIndex: 1
            }}>
                <div style={{ textAlign: 'center', marginBottom: '40px' }}>
                    <div style={{
                        width: '64px',
                        height: '64px',
                        marginBottom: '20px',
                        margin: '0 auto 20px auto',
                        background: 'linear-gradient(135deg, #7877c6 0%, #ff77c6 50%, #78dbff 100%)',
                        borderRadius: '16px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        boxShadow: '0 8px 32px rgba(120, 119, 198, 0.4)',
                        position: 'relative'
                    }}>
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M2 17L12 22L22 17" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M2 12L12 17L22 12" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </div>
                    <h1 style={{
                        margin: '0 0 12px 0',
                        color: '#f8fafc',
                        fontSize: '32px',
                        fontWeight: '700',
                        letterSpacing: '-0.5px'
                    }}>
                        FlyX Admin
                    </h1>
                    <p style={{ margin: 0, color: '#94a3b8', fontSize: '16px', fontWeight: '400' }}>
                        Analytics Dashboard
                    </p>
                </div>

                <form onSubmit={handleLogin}>
                    <div style={{ marginBottom: '24px' }}>
                        <label style={{
                            display: 'block',
                            marginBottom: '10px',
                            color: '#e2e8f0',
                            fontWeight: '500',
                            fontSize: '14px',
                            letterSpacing: '0.5px'
                        }}>
                            Username
                        </label>
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            required
                            disabled={loginLoading}
                            style={{
                                width: '100%',
                                padding: '14px 18px',
                                border: '1px solid rgba(255, 255, 255, 0.1)',
                                borderRadius: '12px',
                                fontSize: '16px',
                                boxSizing: 'border-box',
                                transition: 'all 0.3s ease',
                                outline: 'none',
                                background: 'rgba(255, 255, 255, 0.05)',
                                color: '#f8fafc',
                                WebkitBackdropFilter: 'blur(10px)',
                                backdropFilter: 'blur(10px)'
                            }}
                            onFocus={(e) => {
                                e.target.style.borderColor = '#7877c6';
                                e.target.style.boxShadow = '0 0 0 3px rgba(120, 119, 198, 0.1)';
                                e.target.style.background = 'rgba(255, 255, 255, 0.08)';
                            }}
                            onBlur={(e) => {
                                e.target.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                                e.target.style.boxShadow = 'none';
                                e.target.style.background = 'rgba(255, 255, 255, 0.05)';
                            }}
                        />
                    </div>

                    <div style={{ marginBottom: '24px' }}>
                        <label style={{
                            display: 'block',
                            marginBottom: '10px',
                            color: '#e2e8f0',
                            fontWeight: '500',
                            fontSize: '14px',
                            letterSpacing: '0.5px'
                        }}>
                            Password
                        </label>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            disabled={loginLoading}
                            style={{
                                width: '100%',
                                padding: '14px 18px',
                                border: '1px solid rgba(255, 255, 255, 0.1)',
                                borderRadius: '12px',
                                fontSize: '16px',
                                boxSizing: 'border-box',
                                transition: 'all 0.3s ease',
                                outline: 'none',
                                background: 'rgba(255, 255, 255, 0.05)',
                                color: '#f8fafc',
                                WebkitBackdropFilter: 'blur(10px)',
                                backdropFilter: 'blur(10px)'
                            }}
                            onFocus={(e) => {
                                e.target.style.borderColor = '#7877c6';
                                e.target.style.boxShadow = '0 0 0 3px rgba(120, 119, 198, 0.1)';
                                e.target.style.background = 'rgba(255, 255, 255, 0.08)';
                            }}
                            onBlur={(e) => {
                                e.target.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                                e.target.style.boxShadow = 'none';
                                e.target.style.background = 'rgba(255, 255, 255, 0.05)';
                            }}
                        />
                    </div>

                    {error && (
                        <div style={{
                            background: 'rgba(239, 68, 68, 0.1)',
                            color: '#fca5a5',
                            padding: '14px 18px',
                            borderRadius: '12px',
                            marginBottom: '24px',
                            textAlign: 'center',
                            fontSize: '14px',
                            border: '1px solid rgba(239, 68, 68, 0.2)',
                            WebkitBackdropFilter: 'blur(10px)',
                            backdropFilter: 'blur(10px)'
                        }}>
                            {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={loginLoading}
                        style={{
                            width: '100%',
                            padding: '16px',
                            background: loginLoading
                                ? 'rgba(100, 100, 100, 0.3)'
                                : 'linear-gradient(135deg, #7877c6 0%, #ff77c6 50%, #78dbff 100%)',
                            color: 'white',
                            border: 'none',
                            borderRadius: '12px',
                            fontSize: '16px',
                            fontWeight: '600',
                            cursor: loginLoading ? 'not-allowed' : 'pointer',
                            transition: 'all 0.3s ease',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '10px',
                            position: 'relative',
                            overflow: 'hidden'
                        }}
                        onMouseEnter={(e) => {
                            if (!loginLoading) {
                                e.currentTarget.style.transform = 'translateY(-2px)';
                                e.currentTarget.style.boxShadow = '0 10px 25px rgba(120, 119, 198, 0.4)';
                            }
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.transform = 'translateY(0)';
                            e.currentTarget.style.boxShadow = 'none';
                        }}
                    >
                        {loginLoading && (
                            <div style={{
                                width: '18px',
                                height: '18px',
                                border: '2px solid rgba(255,255,255,0.3)',
                                borderTop: '2px solid white',
                                borderRadius: '50%',
                                animation: 'spin 1s linear infinite'
                            }}></div>
                        )}
                        {loginLoading ? 'Signing in...' : 'Sign In'}
                    </button>
                </form>


            </div>
        </div>
    );
}
