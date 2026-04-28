export default function DashboardLayout({ children, header }) {
  return (
    <div className="min-h-screen bg-surface flex flex-col">
      {header}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
