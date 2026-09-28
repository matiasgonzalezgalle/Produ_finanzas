import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTenant } from '../../app/tenant'
import { api } from '../../data'
import { isValidTaxId, normalizeTaxId, TAX_ID_LABEL, type Country } from '../../domain/taxId'
import { Button, Field, FormError, Input, Select } from '../../ui'
import { AuthShell } from '../auth/AuthPages'
import { errorMessage } from '../shared'

export function OnboardingPage() {
  const { tenants, selectTenant } = useTenant()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [legalName, setLegalName] = useState('')
  const [country, setCountry] = useState<Country>('CL')
  const [taxId, setTaxId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) return setError('Indica el nombre de la empresa')
    if (taxId && !isValidTaxId(taxId, country)) return setError(`${TAX_ID_LABEL[country]} inválido`)
    setLoading(true)
    try {
      const tenant = await api.createTenant({
        name: name.trim(),
        country,
        legal_name: legalName.trim() || undefined,
        tax_id: taxId ? normalizeTaxId(taxId, country) : undefined,
      })
      await qc.invalidateQueries({ queryKey: ['tenants'] })
      selectTenant(tenant.id)
      navigate('/tesoreria')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      title={tenants.length ? 'Nueva empresa' : 'Crea tu empresa'}
      subtitle={tenants.length ? <Link to="/" className="text-brand-600 hover:underline">Volver</Link> : 'Quedarás como dueño y podrás invitar a tu equipo.'}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <Field label="Nombre de fantasía">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
        <Field label="Razón social">{(id) => <Input id={id} value={legalName} onChange={(e) => setLegalName(e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="País" hint={country === 'CL' ? 'CLP · IVA 19%' : 'PEN · IGV 18%'}>
            {(id) => (
              <Select id={id} value={country} onChange={(e) => setCountry(e.target.value as Country)}>
                <option value="CL">Chile</option>
                <option value="PE">Perú</option>
              </Select>
            )}
          </Field>
          <Field label={TAX_ID_LABEL[country]}>{(id) => <Input id={id} value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder={country === 'CL' ? '76.123.456-7' : '20123456789'} />}</Field>
        </div>
        <Button variant="primary" type="submit" disabled={loading} className="mt-2">{loading ? 'Creando…' : 'Crear empresa'}</Button>
      </form>
    </AuthShell>
  )
}
