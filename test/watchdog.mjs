/** A ref'd deadline catches leaked sockets and promises with no completion. */
export function watchdog(cleanup = () => {}, ms = 60_000) {
  const timer = setTimeout(() => {
    console.error(`Test exceeded its ${ms / 1000}s watchdog: ${process.argv[1]}`);
    // Give asynchronous child/socket teardown a bounded chance to finish.
    // This timer stays referenced too, so a stuck cleanup cannot hang the run.
    setTimeout(() => process.exit(1), 5000);
    Promise.resolve().then(cleanup).then(
      () => process.exit(1),
      error => { console.error("Watchdog cleanup failed:", error); process.exit(1); },
    );
  }, ms);
  return () => clearTimeout(timer);
}
