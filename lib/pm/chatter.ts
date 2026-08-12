import { pool } from "@/lib/pm/db";

export type Comment = {
  id: number;
  body: string;
  author: string;
  author_code: string;
  created_at: string | null;
};

export async function getComments(code: string, limit = 50): Promise<Comment[]> {
  const { rows } = await pool.query<Comment>(
    `SELECT c.id, c.body,
            COALESCE(e.fullname_lo, c.created_by, '') AS author,
            COALESCE(c.created_by, '') AS author_code,
            c.created_at::text AS created_at
       FROM odg_product_comment c
       LEFT JOIN odg_employee e ON e.employee_code = c.created_by
      WHERE c.item_code = $1
      ORDER BY c.created_at DESC
      LIMIT ${limit}`,
    [code],
  );
  return rows;
}

export type Activity = {
  id: number;
  title: string;
  assignee_name: string;
  assignee_code: string;
  due_date: string | null;
  status: string;
  created_by_name: string;
  created_at: string | null;
  done_at: string | null;
};

export async function getActivities(code: string): Promise<Activity[]> {
  const { rows } = await pool.query<Activity>(
    `SELECT a.id, a.title,
            COALESCE(asg.fullname_lo, a.assignee, '') AS assignee_name,
            COALESCE(a.assignee, '') AS assignee_code,
            a.due_date::text AS due_date, a.status,
            COALESCE(cb.fullname_lo, a.created_by, '') AS created_by_name,
            a.created_at::text AS created_at,
            a.done_at::text AS done_at
       FROM odg_product_activity a
       LEFT JOIN odg_employee asg ON asg.employee_code = a.assignee
       LEFT JOIN odg_employee cb ON cb.employee_code = a.created_by
      WHERE a.item_code = $1
      ORDER BY (a.status = 'done'), a.due_date ASC NULLS LAST, a.created_at DESC`,
    [code],
  );
  return rows;
}

// Open activities assigned to a given employee (for the global "my tasks" view).
export async function getMyOpenActivities(employeeCode: string, limit = 100): Promise<
  (Activity & { item_code: string; item_name: string })[]
> {
  const { rows } = await pool.query<Activity & { item_code: string; item_name: string }>(
    `SELECT a.id, a.item_code, COALESCE(i.name_1,'') AS item_name, a.title,
            '' AS assignee_name, COALESCE(a.assignee,'') AS assignee_code,
            a.due_date::text AS due_date, a.status,
            COALESCE(cb.fullname_lo, a.created_by, '') AS created_by_name,
            a.created_at::text AS created_at, a.done_at::text AS done_at
       FROM odg_product_activity a
       LEFT JOIN ic_inventory i ON i.code = a.item_code
       LEFT JOIN odg_employee cb ON cb.employee_code = a.created_by
      WHERE a.assignee = $1 AND a.status = 'open'
      ORDER BY a.due_date ASC NULLS LAST, a.created_at DESC
      LIMIT ${limit}`,
    [employeeCode],
  );
  return rows;
}
