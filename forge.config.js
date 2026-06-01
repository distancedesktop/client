module.exports = {
  packagerConfig: {
    name: 'Distance Desktop',
    appBundleId: 'com.distance.desktop-client',
    appCategoryType: 'public.app-category.utilities',
    asar: true,
    ignore: [
      /^\/src/,
      /^\/scripts/,
      /^\/node_modules\/\.cache/,
      /^\/\.git/,
      /^\/\.gitignore/,
      /^\/forge\.config\.js/,
      /^\/tsconfig.*/,
      /^\/vite\.config\.ts/,
      /^\/README\.md/,
      /^\/LICENSE/,
      /^\/\.DS_Store/,
    ],
  },
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      config: {},
    },
  ],
}
