import { listScheduleEvents } from "@/db/repository";
import {
  data,
  HttpError,
  requireApiUser,
  routeError,
} from "@/app/_server/api";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireApiUser();
    const id = (await context.params).id;
    if (!id) throw new HttpError(404, "That schedule was not found.");
    return data(await listScheduleEvents(id, user.email));
  } catch (error) {
    return routeError(error);
  }
}
