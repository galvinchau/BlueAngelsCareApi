import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { FileReportsService } from "./file-reports.service";

async function main() {
  console.log("TEST-GENERATE-DOCX: script started");

  const prisma = new PrismaClient();

  try {
    const first = await prisma.dailyNote.findFirst({
      orderBy: [{ createdAt: "desc" }],
      select: { id: true },
    });

    if (!first?.id) {
      throw new Error("No DailyNote found in DB");
    }

    const dailyNoteId = first.id;
    console.log("Using DailyNote ID from current DB:", dailyNoteId);

    // Minimal mock of PrismaService shape (FileReportsService only needs prisma.dailyNote.*)
    const fileReports = new FileReportsService(prisma as any);

    const staffPath = await fileReports.generateStaffDocx(dailyNoteId);
    console.log("DOCX generated at:", staffPath);

    console.log("TEST-GENERATE-DOCX: done");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("TEST-GENERATE-DOCX: ERROR", err);
  process.exit(1);
});
