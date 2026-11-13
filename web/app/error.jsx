'use client';

export default function GlobalError({ error, reset }) {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-5xl">⚠️</div>
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm text-slate-500">{error?.message}</p>
      <button onClick={() => reset()} className="rounded-lg bg-brand-600 px-4 py-2 text-sm text-white">
        Try again
      </button>
    </main>
  );
}
