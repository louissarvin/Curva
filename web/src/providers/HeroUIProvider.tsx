import { HeroUIProvider as Provider } from '@heroui/react'

interface HeroUIProviderProps {
  children: React.ReactNode
}

export default function HeroUIProvider({ children }: HeroUIProviderProps) {
  return <Provider>{children}</Provider>
}
