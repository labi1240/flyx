'use client';

import { useState, useRef, useEffect } from 'react';
import { useAdmin } from '../context/AdminContext';
import { Calendar, ChevronDown } from 'lucide-react';

export default function DateRangePicker() {
    const { dateRange, setDateRange } = useAdmin();
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handlePresetChange = (period: 'day' | 'week' | 'month' | 'year') => {
        setDateRange({
            startDate: null,
            endDate: null,
            period
        });
        setIsOpen(false);
    };

    const getLabel = () => {
        if (dateRange.period === 'custom' && dateRange.startDate && dateRange.endDate) {
            return `${dateRange.startDate.toLocaleDateString()} - ${dateRange.endDate.toLocaleDateString()}`;
        }
        switch (dateRange.period) {
            case 'day': return 'Last 24 Hours';
            case 'week': return 'Last 7 Days';
            case 'month': return 'Last 30 Days';
            case 'year': return 'Last Year';
            default: return 'Select Date Range';
        }
    };

    return (
        <div style={{ position: 'relative' }} ref={dropdownRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 16px',
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '8px',
                    color: '#e2e8f0',
                    fontSize: '14px',
                    fontWeight: '500',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'}
            >
                <Calendar size={16} color="#94a3b8" />
                <span>{getLabel()}</span>
                <ChevronDown size={14} color="#94a3b8" />
            </button>

            {isOpen && (
                <div style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: '8px',
                    background: '#1e1e2e', // Dark background matching theme
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '12px',
                    padding: '8px',
                    minWidth: '200px',
                    boxShadow: '0 10px 40px rgba(0, 0, 0, 0.4)',
                    zIndex: 50,
                    WebkitBackdropFilter: 'blur(20px)',
                    backdropFilter: 'blur(20px)'
                }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {[
                            { label: 'Last 24 Hours', value: 'day' },
                            { label: 'Last 7 Days', value: 'week' },
                            { label: 'Last 30 Days', value: 'month' },
                            { label: 'Last Year', value: 'year' }
                        ].map((option) => (
                            <button
                                key={option.value}
                                onClick={() => handlePresetChange(option.value as any)}
                                style={{
                                    textAlign: 'left',
                                    padding: '8px 12px',
                                    background: dateRange.period === option.value ? 'rgba(120, 119, 198, 0.2)' : 'transparent',
                                    border: 'none',
                                    borderRadius: '6px',
                                    color: dateRange.period === option.value ? '#fff' : '#94a3b8',
                                    fontSize: '14px',
                                    cursor: 'pointer',
                                    transition: 'all 0.2s ease'
                                }}
                                onMouseEnter={(e) => {
                                    if (dateRange.period !== option.value) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                                }}
                                onMouseLeave={(e) => {
                                    if (dateRange.period !== option.value) e.currentTarget.style.background = 'transparent';
                                }}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
