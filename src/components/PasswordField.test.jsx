import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PasswordField } from './PasswordField'

describe('PasswordField visibility control', () => {
  it('starts hidden and toggles visibility with an accessible button', () => {
    render(<PasswordField id="password" label="Password" value="private-value" onChange={() => {}} autoComplete="current-password" />)

    const input = document.getElementById('password')
    expect(input).toHaveAttribute('type', 'password')

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(input).toHaveAttribute('type', 'text')

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(input).toHaveAttribute('type', 'password')
  })
})
