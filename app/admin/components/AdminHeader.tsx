'use client';

import DateRangePicker from './DateRangePicker';
import { Bell, Search } from 'lucide-react';

export default function AdminHeader() {
    return (
        <header style={{
            height: '80px',
            padding: '0 32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            background: 'rgba(15, 23, 42, 0.4)',
            WebkitBackdropFilter: 'blur(20px)',
            backdropFilter: 'blur(20px)',
            position: 'sticky',
            top: 0,
            zIndex: 40
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
                <h1 style={{
                    fontSize: '24px',
                    fontWeight: '700',
                    color: '#f8fafc',
                    margin: 0
                }}>
                    Dashboard
                </h1>
                <DateRangePicker />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
                <div style={{ position: 'relative' }}>
                    <Search size={20} color="#94a3b8" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
                    <input
                        type="text"
                        placeholder="Search..."
                        style={{
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '8px',
                            padding: '8px 12px 8px 40px',
                            color: '#e2e8f0',
                            outline: 'none',
                            width: '240px'
                        }}
                    />
                </div>

                <button style={{
                    background: 'transparent',
                    border: 'none',
                    position: 'relative',
                    cursor: 'pointer'
                }}>
                    <Bell size={20} color="#94a3b8" />
                    <span style={{
                        position: 'absolute',
                        top: '-2px',
                        right: '-2px',
                        width: '8px',
                        height: '8px',
                        background: '#ef4444',
                        borderRadius: '50%'
                    }}></span>
                </button>

                <div style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '50%',
                    background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'white',
                    fontWeight: '600',
                    fontSize: '14px',
                    cursor: 'pointer'
                }}>
                    AD
                </div>
            </div>
        </header>
    );
}
