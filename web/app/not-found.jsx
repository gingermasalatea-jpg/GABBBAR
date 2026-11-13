import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-5xl">🔍</div>
      <h1 className="text-lg font-semibold">Page not found</h1>
      <Link href="/inbox" className="text-sm text-brand-700 underline">
        Back to inbox
      </Link>
    </main>
  );
}
