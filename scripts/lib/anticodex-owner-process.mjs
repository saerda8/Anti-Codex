export function ownerProcessIsAlive(pidValue, signalProcess = process.kill.bind(process)) {
  const pid = Number(pidValue || 0);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
