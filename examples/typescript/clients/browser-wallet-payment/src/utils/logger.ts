export function addLog(
  message: string,
  type: 'success' | 'error' | 'info' = 'info',
  logs: { value: Array<{ time: string; message: string; type: string }> }
) {
  const now = new Date();
  const time = `${now.getHours().toString().padStart(2, '0')}:${now
    .getMinutes()
    .toString()
    .padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

  logs.value.push({
    time,
    message,
    type,
  });

  // Keep at most 100 logs
  if (logs.value.length > 100) {
    logs.value.shift();
  }
}

