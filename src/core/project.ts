/** Project scope key — git-root normalization lands in Layer 6; cwd for now. */
export function projectIdFromPath(projectPath: string): string {
  return projectPath || 'unknown'
}
