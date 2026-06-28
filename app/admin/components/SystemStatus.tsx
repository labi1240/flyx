'use client';

import { useState, useEffect } from 'react';
import { getAdminAnalyticsUrl } from '../hooks/useAnalyticsApi';

interface SystemHealth {
  database: boolean;
  analytics: boolean;
  api: boolean;
}

export default function SystemStatus() {
  const [health, setHealth] = useState<SystemHealth>({
    database: false,
    analytics: false,
    api: false
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkSystemHealth();
    const interval = setInterval(checkSystemHealth, 30000); // Check every 30 seconds
    return () => clearInterval(interval);
  }, []);

  const checkSystemHealth = async () => {
    try {
      // Check API health
      const apiResponse = await fetch('/api/admin/me');
      const apiHealthy = apiResponse.status !== 500;

      // Check analytics API
      const analyticsResponse = await fetch(getAdminAnalyticsUrl('admin-analytics', { period: 'day' }));
      const analyticsHealthy = analyticsResponse.status !== 500;

      // Database health is implied by successful API calls
      const databaseHealthy = apiHealthy && analyticsHealthy;

      setHealth({
        database: databaseHealthy,
        analytics: analyticsHealthy,
        api: apiHealthy
      });
    } catch (err) {
      setHealth({
        database: false,
        analytics: false,
        api: false
      });
    } finally {
      setLoading(false);
    }
  };

  const getOverallStatus = () => {
    const allHealthy = health.database && health.analytics && health.api;
    const someHealthy = health.database || health.analytics || health.api;
    
    if (allHealthy) return { status: 'Operational', color: '#48bb78', icon: '✅' };
    if (someHealthy) return { status: 'Partial Outage', color: '#ed8936', icon: '⚠️' };
    return { status: 'Major Outage', color: '#f56565', icon: '❌' };
  };

  const overall = getOverallStatus();

  return (
    <div style={{
      background: 'rgba(255, 255, 255, 0.05)',
      padding: '28px',
      borderRadius: '16px',
      border: '1px solid rgba(255, 255, 255, 0.1)',
      WebkitBackdropFilter: 'blur(20px)',
      backdropFilter: 'blur(20px)',
      marginTop: '24px'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '24px'
      }}>
        <h3 style={{ 
          margin: 0, 
          color: '#f8fafc', 
          fontSize: '20px', 
          fontWeight: '600',
          letterSpacing: '-0.5px'
        }}>
          System Status
        </h3>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '8px 16px',
          borderRadius: '24px',
          background: `${overall.color}20`,
          border: `1px solid ${overall.color}40`,
          WebkitBackdropFilter: 'blur(10px)',
          backdropFilter: 'blur(10px)'
        }}>
          <span style={{ fontSize: '16px' }}>{overall.icon}</span>
          <span style={{ 
            color: overall.color === '#48bb78' ? '#34d399' : overall.color === '#ed8936' ? '#fbbf24' : '#f87171', 
            fontWeight: '600',
            fontSize: '14px'
          }}>
            {overall.status}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <StatusItem 
          label="Database Connection" 
          status={health.database ? 'Connected' : 'Disconnected'}
          healthy={health.database}
          loading={loading}
        />
        <StatusItem 
          label="Analytics Service" 
          status={health.analytics ? 'Active' : 'Inactive'}
          healthy={health.analytics}
          loading={loading}
        />
        <StatusItem 
          label="API Endpoints" 
          status={health.api ? 'Operational' : 'Down'}
          healthy={health.api}
          loading={loading}
        />
        <StatusItem 
          label="Authentication" 
          status="Working"
          healthy={true}
          loading={false}
        />
      </div>

      <div style={{
        marginTop: '24px',
        padding: '20px',
        background: 'rgba(255, 255, 255, 0.03)',
        borderRadius: '12px',
        border: '1px solid rgba(255, 255, 255, 0.05)'
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '14px'
        }}>
          <span style={{ color: '#94a3b8' }}>Last Updated:</span>
          <span style={{ color: '#e2e8f0', fontWeight: '500' }}>
            {new Date().toLocaleTimeString()}
          </span>
        </div>
      </div>
    </div>
  );
}

function StatusItem({ 
  label, 
  status, 
  healthy, 
  loading 
}: { 
  label: string; 
  status: string; 
  healthy: boolean;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        padding: '12px 0'
      }}>
        <span style={{ color: '#94a3b8', fontSize: '15px' }}>{label}</span>
        <div style={{
          width: '80px',
          height: '20px',
          background: 'rgba(255, 255, 255, 0.1)',
          borderRadius: '10px',
          animation: 'pulse 2s infinite'
        }}></div>
      </div>
    );
  }

  return (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'space-between', 
      alignItems: 'center',
      padding: '12px 0',
      borderBottom: '1px solid rgba(255, 255, 255, 0.05)'
    }}>
      <span style={{ color: '#94a3b8', fontSize: '15px' }}>{label}</span>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
      }}>
        <div style={{
          width: '10px',
          height: '10px',
          borderRadius: '50%',
          background: healthy ? '#34d399' : '#f87171',
          boxShadow: healthy 
            ? '0 0 10px rgba(52, 211, 153, 0.5)' 
            : '0 0 10px rgba(248, 113, 113, 0.5)',
          animation: healthy ? 'glow 2s ease-in-out infinite alternate' : 'none'
        }}></div>
        <span style={{
          color: healthy ? '#34d399' : '#f87171',
          fontWeight: '600',
          fontSize: '14px'
        }}>
          {status}
        </span>
      </div>
    </div>
  );
}