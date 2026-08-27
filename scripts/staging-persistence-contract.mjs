export const PERSISTENT_VOLUME_ROLES = Object.freeze([
  "postgres",
  "redis",
  "minio",
]);

export const PERSISTENT_SERVICES = Object.freeze([
  "postgres",
  "redis",
  "minio",
  "clamav",
]);

export function persistentVolumeName(projectName, role) {
  if (!PERSISTENT_VOLUME_ROLES.includes(role)) {
    throw new Error(`Unsupported staging persistence role: ${role}`);
  }
  return `${projectName}_atoms_${role}_data`;
}

export function persistentVolumeLabels(projectName, role) {
  return {
    "com.atoms.compose-project": projectName,
    "com.atoms.data-role": role,
    "com.atoms.environment": "staging",
    "com.atoms.managed-by": "staging-persistence-bootstrap",
  };
}

export function validatePersistentVolumeLabels(projectName, role, labels) {
  const expected = persistentVolumeLabels(projectName, role);
  return Object.entries(expected)
    .filter(([name, value]) => labels?.[name] !== value)
    .map(([name]) => name);
}
