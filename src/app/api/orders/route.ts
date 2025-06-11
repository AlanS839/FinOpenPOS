import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const orderSchema = z.object({
  customerId: z.coerce.number(),
  paymentMethodId: z.coerce.number().optional(),
  total: z.coerce.number(),
  status: z.enum(['completed', 'pending', 'cancelled']).optional(),
  created_at: z.string().optional(),
  products: z.array(z.object({
    id: z.coerce.number(),
    quantity: z.coerce.number().int(),
    price: z.coerce.number(),
  })).optional().default([])
})

export async function GET(request: Request) {
  const supabase = createClient();

  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('orders')
    .select(`
      id,
      customer_id,
      total_amount,
      user_uid,
      status,
      created_at,
      customer:customer_id (
        name
      )
      `)
    .eq('user_uid', user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data)
}

export async function POST(request: Request) {
  const supabase = createClient();

  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json();
  const parsed = orderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }
  const { customerId, paymentMethodId, products, total, status, created_at } = parsed.data;

  try {
    // Insert the order
    const { data: orderData, error: orderError } = await supabase
      .from('orders')
      .insert({
        customer_id: customerId,
        total_amount: total,
        user_uid: user.id,
        status: status ?? 'completed',
        ...(created_at ? { created_at } : {})
      })
      .select('*, customer:customers(name)')
      .single();

    if (orderError) {
      throw orderError;
    }

    // Insert the order items
    const orderItems = products.map((product: { id: number, quantity: number, price: number }) => ({
      order_id: orderData.id,
      product_id: product.id,
      quantity: product.quantity,
      price: product.price
    }));

    if (orderItems.length > 0) {
      const { error: itemsError } = await supabase
        .from('order_items')
        .insert(orderItems);

      if (itemsError) {
        await supabase.from('orders').delete().eq('id', orderData.id);
        throw itemsError;
      }
    }

    // Insert the transaction record
    if (paymentMethodId) {
      const { error: transactionError } = await supabase
        .from('transactions')
        .insert({
          order_id: orderData.id,
          payment_method_id: paymentMethodId,
          amount: total,
          user_uid: user.id,
          status: 'completed',
          category: 'selling',
          type: 'income',
          description: `Payment for order #${orderData.id}`
        });

      if (transactionError) {
        await supabase.from('orders').delete().eq('id', orderData.id);
        if (orderItems.length > 0) {
          await supabase.from('order_items').delete().eq('order_id', orderData.id);
        }
        throw transactionError;
      }
    }

    return NextResponse.json(orderData);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
