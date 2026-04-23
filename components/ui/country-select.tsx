'use client'

import type { ComponentProps } from 'react'
import { Select } from '@/components/ui/select'
import { COUNTRY_LIST, toIsoCountryCode } from '@/lib/countries'

type CountrySelectProps = Omit<ComponentProps<typeof Select>, 'value' | 'onChange'> & {
  value?: string | null
  onChange?: (value: string) => void
  allowBlank?: boolean
  blankLabel?: string
}

export function CountrySelect({
  value,
  onChange,
  allowBlank = true,
  blankLabel = 'Select country',
  ...props
}: CountrySelectProps) {
  const normalizedValue = toIsoCountryCode(value) ?? ''

  return (
    <Select
      value={normalizedValue}
      onChange={(event) => onChange?.(event.target.value)}
      {...props}
    >
      {allowBlank ? <option value="">{blankLabel}</option> : null}
      {COUNTRY_LIST.map((country) => (
        <option key={country.code} value={country.code}>
          {country.name}
        </option>
      ))}
    </Select>
  )
}
