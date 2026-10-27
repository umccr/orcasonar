export function node24PartialBuildSpec(): Record<string, unknown> {
  return {
    phases: {
      install: {
        'runtime-versions': {
          nodejs: '24.x',
        },
      },
    },
    version: '0.2',
  };
}
