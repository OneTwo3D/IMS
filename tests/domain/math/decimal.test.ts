import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  addMoney,
  compareDecimal,
  isZero,
  multiplyMoney,
  roundMoney,
  roundQuantity,
  subtractMoney,
  toDecimal,
} from '@/lib/domain/math/decimal'

test('toDecimal accepts Prisma Decimal, string, number, and nullish values', () => {
  const prismaDecimal = new Prisma.Decimal('12.3400')
  const decimalLike: Prisma.DecimalJsLike = {
    d: [1230000],
    e: 0,
    s: 1,
    toFixed: () => '1.230000',
  }

  assert.equal(toDecimal(prismaDecimal), prismaDecimal)
  assert.equal(toDecimal(decimalLike).toString(), '1.23')
  assert.equal(toDecimal('0.10').toString(), '0.1')
  assert.equal(toDecimal(0.2).toString(), '0.2')
  assert.equal(toDecimal(null).toString(), '0')
  assert.equal(toDecimal(undefined).toString(), '0')
  assert.equal(toDecimal('  ').toString(), '0')
})

test('money arithmetic avoids binary floating point drift', () => {
  assert.equal(addMoney('0.1', '0.2').toString(), '0.3')
  assert.equal(subtractMoney('10.00', '0.01').toString(), '9.99')
  assert.equal(multiplyMoney('19.99', '3').toString(), '59.97')
})

test('money rounding uses currency minor units and half-up behavior', () => {
  assert.equal(roundMoney('10.005', 'GBP').toString(), '10.01')
  assert.equal(roundMoney('10.025', 'GBP').toString(), '10.03')
  assert.equal(roundMoney('10.004', 'gbp').toString(), '10')
  assert.equal(roundMoney('123.5', 'JPY').toString(), '124')
  assert.equal(roundMoney('12500.7', 'KRW').toString(), '12501')
  assert.equal(roundMoney('12.5', 'ISK').toString(), '13')
  assert.equal(roundMoney('1.2345', 'KWD').toString(), '1.235')
  assert.equal(roundMoney('1.23456', 'CLF').toString(), '1.2346')
  assert.equal(roundMoney('1.23454', 'UYW').toString(), '1.2345')
  assert.equal(roundMoney('12.345', 'HUF').toString(), '12.35')
  assert.equal(roundMoney('12.345', 'MGA').toString(), '12.35')
})

test('quantity rounding supports configured precision', () => {
  assert.equal(roundQuantity('2.5', 0).toString(), '3')
  assert.equal(roundQuantity('1.23445', 4).toString(), '1.2345')
  assert.equal(roundQuantity('1.23444', 4).toString(), '1.2344')
  assert.equal(roundQuantity('0.00005', 4).toString(), '0.0001')
})

test('tax and discount calculations stay exact until explicit rounding', () => {
  const net = toDecimal('19.99')
  const vat = multiplyMoney(net, '0.20')
  const gross = addMoney(net, vat)
  const discounted = subtractMoney(gross, '2.005')

  assert.equal(vat.toString(), '3.998')
  assert.equal(roundMoney(vat, 'GBP').toString(), '4')
  assert.equal(roundMoney(discounted, 'GBP').toString(), '21.98')
})

test('FX multiplication preserves precision before currency rounding', () => {
  const gbp = toDecimal('100')
  const eurRate = toDecimal('1.17234567')
  const eur = multiplyMoney(gbp, eurRate)

  assert.equal(eur.toString(), '117.234567')
  assert.equal(roundMoney(eur, 'EUR').toString(), '117.23')
})

test('comparison and zero checks use decimal semantics', () => {
  assert.equal(compareDecimal('0.30', addMoney('0.1', '0.2')), 0)
  assert.equal(compareDecimal('0.2999', '0.3'), -1)
  assert.equal(compareDecimal('0.3001', '0.3'), 1)
  assert.equal(isZero('0.0000'), true)
  assert.equal(isZero('0.0001'), false)
})

test('invalid numbers and precision are rejected', () => {
  assert.throws(() => toDecimal(Number.NaN), /Invalid decimal number/)
  assert.throws(() => toDecimal('Infinity'), /Invalid decimal string/)
  assert.throws(() => toDecimal('-Infinity'), /Invalid decimal string/)
  assert.throws(() => toDecimal('NaN'), /Invalid decimal string/)
  assert.throws(() => roundQuantity('1.23', -1), /non-negative integer/)
  assert.throws(() => roundQuantity('1.23', 1.5), /non-negative integer/)
})
