interface AppConfig {
  appName: string
  appDescription: string
  links: {
    twitter: string
    github: string
    telegram: string
    discord: string
    docs: string
    buy: string
  }
  contracts: {
    main: string
    token: string
  }
  features: {
    darkMode: boolean
    smoothScroll: boolean
  }
}

export const config: AppConfig = {
  appName: 'Curva',
  appDescription: 'Watch the World Cup with friends, peer-to-peer.',

  // Social links
  links: {
    twitter: 'https://x.com/search?q=%23ForzaCurva',
    github: 'https://github.com/placeholder-curva-repo',
    telegram: '',
    discord: '',
    docs: 'https://dorahacks.io',
    buy: '',
  },

  // Contract/wallet related (if needed)
  contracts: {
    main: '',
    token: '0xd077a400968890eacc75cdc901f0356c943e4fdb',
  },

  // Feature flags
  features: {
    darkMode: true,
    smoothScroll: true,
  },
}

export type Config = AppConfig
