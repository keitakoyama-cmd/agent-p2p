import { json, readBody } from "../http-util";
import type { DaemonContext, RequestContext } from "../context";
import type { AgentId, InvoiceIssuePayload } from "../../types/protocol";

export async function handleBilling(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { billing } = ctx;
  const { req, res, url, path } = rc;

  if (path === "/audit" || path === "/invoices" || path.startsWith("/invoices/")) {
    if (!billing) {
      json(res, 404, { error: "Billing plugin is disabled" });
      return true;
    }

    if (req.method === "GET" && path === "/invoices") {
      const invoiceId = url.searchParams.get("invoice_id");
      if (invoiceId) {
        const invoice = billing.getInvoice(invoiceId);
        const audit = billing.getAuditLog(invoiceId);
        json(res, invoice ? 200 : 404, { invoice, audit });
      } else {
        json(res, 200, billing.listInvoices());
      }
      return true;
    }

    if (req.method === "POST" && path === "/invoices/issue") {
      const body = JSON.parse(await readBody(req));
      const result = billing.issueInvoice(
        body.target_agent_id as AgentId,
        body.invoice as InvoiceIssuePayload
      );
      json(res, result.success ? 200 : 422, result);
      return true;
    }

    if (req.method === "POST" && path === "/invoices/accept") {
      const body = JSON.parse(await readBody(req));
      const result = billing.acceptInvoice(
        body.invoice_id,
        body.scheduled_payment_date
      );
      json(res, result.success ? 200 : 422, result);
      return true;
    }

    if (req.method === "POST" && path === "/invoices/reject") {
      const body = JSON.parse(await readBody(req));
      const result = billing.rejectInvoice(
        body.invoice_id,
        body.reason_code,
        body.reason_message
      );
      json(res, result.success ? 200 : 422, result);
      return true;
    }

    if (req.method === "GET" && path === "/audit") {
      const invoiceId = url.searchParams.get("invoice_id") ?? undefined;
      json(res, 200, billing.getAuditLog(invoiceId));
      return true;
    }
  }

  return false;
}
