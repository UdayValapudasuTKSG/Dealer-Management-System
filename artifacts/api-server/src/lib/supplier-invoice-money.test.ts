import test from "node:test";
import assert from "node:assert/strict";
import { minor, decimal, allocate, flags } from "./supplier-invoice-money";
test("fixed minor-unit decimals reject floating precision and negative values",()=>{
  assert.equal(minor("12.01"),1201n);assert.equal(decimal(1201n),"12.01");
  assert.throws(()=>minor("1.001"));assert.throws(()=>minor("-1"));
});
test("quantity compares received rather than ordered and defaults to zero tolerance",()=>{
  assert.deepEqual(flags(10,8,100n,100n),["qty_variance"]);
  assert.deepEqual(flags(8,8,101n,100n),["price_variance"]);
  assert.deepEqual(flags(8,8,101n,100n,100),[]);
  assert.deepEqual(flags(1,0,0n,0n,10000),["qty_variance"]);
});
test("pro rata uses deterministic largest remainder pennies, ignores zero-value lines",()=>{
  assert.deepEqual(allocate(2n,[1n,1n,1n]),[1n,1n,0n]);
  assert.deepEqual(allocate(7n,[0n,1n,2n]),[0n,2n,5n]);
  assert.deepEqual(allocate(0n,[0n,0n]),[0n,0n]);
  assert.throws(()=>allocate(1n,[0n,0n]));
  for(let total=0n;total<100n;total++)assert.equal(allocate(total,[17n,33n,5n]).reduce((a,b)=>a+b,0n),total);
});