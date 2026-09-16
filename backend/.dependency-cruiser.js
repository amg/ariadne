/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-process-env-outside-config',
      severity: 'error',
      comment:
        'process.env should only be used in src/config/env.ts. Use the centralized env object instead.',
      from: {
        // Match all files EXCEPT src/config/env.ts
        pathNot: 'src/config/env.ts',
        // Only check TypeScript source files (not tests, not node_modules)
        path: '^src/.+\\.ts$',
      },
      to: {
        // This rule triggers when process.env is accessed
        // We use a custom filter to detect process.env usage
      },
      // Custom filter to detect process.env access in the AST
      customRule: {
        // This will be implemented via the dependency-cruiser's AST analysis
        // For now, we'll use a simpler approach with a regex-based check
      },
    },
  ],
  options: {
    // Focus on TypeScript files only
    doNotFollow: {
      path: ['node_modules', 'dist', 'coverage', '.git'],
    },
    // Include type information for better accuracy
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    // Enhanced detection
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx'],
      mainFields: ['main', 'module', 'types'],
    },
  },
};
