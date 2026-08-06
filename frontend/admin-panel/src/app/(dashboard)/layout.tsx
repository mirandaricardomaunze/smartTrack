import type { Metadata } from 'next';
import Sidebar from '@/components/layout/Sidebar';
import Topbar from '@/components/layout/Topbar';
import LocationReporter from '@/components/LocationReporter';
import SubscriptionBanner from '@/components/SubscriptionBanner';

export const metadata: Metadata = {
  title: { default: 'Dashboard', template: '%s | SmartTrack Admin' },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-surface-base">
      <LocationReporter />
      <Sidebar />
      {/* flex-1 cresce conforme o sidebar muda de width via CSS transition */}
      <div className="flex flex-col flex-1 min-w-0 min-h-screen overflow-hidden">
        <Topbar />
        {/* Estado da subscrição (SaaS, spec § 2.5) — só aparece quando há algo a decidir. */}
        <SubscriptionBanner />
        <main className="flex-1 p-6 overflow-y-auto animate-fade-in">
          {children}
        </main>
      </div>
    </div>
  );
}
