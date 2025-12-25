import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    console.log("Auth Header present:", !!authHeader);

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: {
          headers: { Authorization: authHeader! },
        },
      }
    );

    // Get the user from the authorization header
    const {
      data: { user },
      error: authError,
    } = await supabaseClient.auth.getUser();

    if (authError || !user) {
      console.error("Auth Error:", authError);
      return new Response(JSON.stringify({ 
        error: "Unauthorized", 
        details: authError,
        debug: { hasAuth: !!authHeader } 
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }


    // Verify if the user is an admin
    // We use the Service Role client to bypass RLS for this check to be sure,
    // or just trust the RLS on the profiles table if reading is allowed.
    // For safety in critical ops, let's use Service Role for the operations.
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (!profile || profile.role !== "admin") {
      return new Response(JSON.stringify({ error: "Forbidden: Admins only" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 403,
      });
    }

    const { action, payload } = await req.json();

    if (action === "recharge") {
      const { user_id, amount } = payload;
      if (!user_id || !amount || amount <= 0) {
        throw new Error("Invalid parameters");
      }

      // 1. Get current balance (optional, but good for logs/verification)
      // 2. Increment Balance
      // 3. Log Transaction

      // We use RPC if available for atomicity, but here we construct a manual transaction via multiple queries
      // or usage of a stored procedure if we wrote one.
      // Since we are in an Edge Function, we can chain operations.
      // Ideally, we'd use a transaction, but Supabase JS doesn't support transactions over HTTP yet directly easily without RPC.
      // However, we can just do the updates. Failures might leave inconsistent state, but it's better than client-side.

      // Update Wallet
      const { data: wallet, error: walletError } = await supabaseAdmin
        .from("wallets")
        .select("balance")
        .eq("user_id", user_id)
        .single();
      
      if (walletError && walletError.code !== 'PGRST116') throw walletError;

      let newBalance = amount;
      if (wallet) {
        newBalance = (Number(wallet.balance) || 0) + Number(amount);
        const { error: updateError } = await supabaseAdmin
          .from("wallets")
          .update({ balance: newBalance })
          .eq("user_id", user_id);
        if (updateError) throw updateError;
      } else {
        // Create wallet if not exists
        const { error: insertError } = await supabaseAdmin
          .from("wallets")
          .insert({ user_id, balance: newBalance });
        if (insertError) throw insertError;
      }

      // Log Transaction
      const { error: txError } = await supabaseAdmin
        .from("transactions")
        .insert({
          user_id,
          type: "recharge",
          amount,
          related_id: user.id, // Admin ID
        });

      if (txError) {
        // Determine if we need to rollback wallet? 
        // For now, just throw, admin can see mismatch.
        throw txError;
      }

      return new Response(JSON.stringify({ success: true, newBalance }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    if (action === "update_profile") {
      const { user_id, values } = payload;
      if (!user_id || !values) throw new Error("Invalid parameters");

      const { error: updateError } = await supabaseAdmin
        .from("profiles")
        .update(values)
        .eq("id", user_id);

      if (updateError) throw updateError;

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    if (action === "delete_user") {
        const { user_id } = payload;
        if (!user_id) throw new Error("Invalid parameters");

        const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(user_id);

        if (deleteError) throw deleteError;

        return new Response(JSON.stringify({ success: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
        });
    }

    if (action === "subsidy_manual") {
      const { user_id, amount, reason } = payload;
      if (!user_id || !amount) {
        throw new Error("Invalid parameters");
      }

      // Update Wallet
      const { data: wallet, error: walletError } = await supabaseAdmin
        .from("wallets")
        .select("balance")
        .eq("user_id", user_id)
        .single();
      
      if (walletError && walletError.code !== 'PGRST116') throw walletError;

      let newBalance = Number(amount);
      if (wallet) {
        newBalance = (Number(wallet.balance) || 0) + Number(amount);
        const { error: updateError } = await supabaseAdmin
          .from("wallets")
          .update({ balance: newBalance })
          .eq("user_id", user_id);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await supabaseAdmin
          .from("wallets")
          .insert({ user_id, balance: newBalance });
        if (insertError) throw insertError;
      }

      // Log Subsidy
      const { error: logError } = await supabaseAdmin
        .from("subsidy_logs")
        .insert({
          user_id,
          type: "manual",
          amount,
          rule_snapshot: { reason: reason || "Admin Manual" },
        });

      if (logError) throw logError;

      // Also Log Transaction for unified history
      await supabaseAdmin.from("transactions").insert({
        user_id,
        type: "subsidy",
        amount,
        related_id: user.id,
      });

      return new Response(JSON.stringify({ success: true, newBalance }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    throw new Error("Invalid action");

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
});
