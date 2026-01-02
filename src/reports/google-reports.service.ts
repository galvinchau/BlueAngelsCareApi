// src/reports/google-reports.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { google, docs_v1, drive_v3 } from 'googleapis';
import * as path from 'path';
import type { MobileDailyNotePayload } from '../mobile/mobile.service';

@Injectable()
export class GoogleReportsService {
  private readonly logger = new Logger(GoogleReportsService.name);

  // 👉 3 ID anh cung cấp
  private readonly TEMPLATE_DOC_ID = '1yU0JJNVC3ly26ArSt0Mt9SimqP9Kcms8';
  private readonly STAFF_FOLDER_ID = '1tzYB18okPZjEpv9Dkeubf79c9C7OZPHA';
  private readonly INDIVIDUAL_FOLDER_ID = '1ztUpuDZ0phmN-ORcc6n6Vmkw1gEKZZc2';

  private readonly auth;

  constructor() {
    const keyFile = path.resolve(process.cwd(), 'google-service-account.json');

    this.logger.log(`[INIT] Using service account key file at: ${keyFile}`);

    this.auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: [
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/drive',
      ],
    });
  }

  private async getDocsClient(): Promise<docs_v1.Docs> {
    const authClient = await this.auth.getClient();
    return google.docs({ version: 'v1', auth: authClient });
  }

  private async getDriveClient(): Promise<drive_v3.Drive> {
    const authClient = await this.auth.getClient();
    return google.drive({ version: 'v3', auth: authClient });
  }

  /**
   * Build map tag -> value để replace trong template
   * (Anh có thể bổ sung thêm tag sau)
   */
  private buildReplacements(
    payload: MobileDailyNotePayload,
  ): Record<string, string> {
    const dateFull = payload.date ?? '';

    return {
      '{{ServiceType}}': payload.serviceName ?? '',
      '{{PatientName}}': payload.individualName ?? '',
      '{{PatientMA}}': payload.individualMa ?? '',
      '{{DateFull}}': dateFull,
      '{{StaffNickname}}': payload.staffName ?? '',
      '{{ScheduleStart}}': payload.scheduleStart ?? '',
      '{{ScheduleEnd}}': payload.scheduleEnd ?? '',
      '{{StartTime}}': payload.visitStart ?? '',
      '{{EndTime}}': payload.visitEnd ?? '',
      '{{Mileage}}':
        typeof payload.mileage === 'number' ? String(payload.mileage) : '',
      // Tạm thời gán OverReason/ShortReason từ notes/opportunities
      '{{OverReason}}': payload.opportunities ?? '',
      '{{ShortReason}}': payload.notes ?? '',
    };
  }

  /**
   * Copy template vào 1 folder, replace tag, export PDF
   * Trả về: id file DOC & PDF
   */
  private async copyAndFillTemplate(
    folderId: string,
    fileName: string,
    payload: MobileDailyNotePayload,
  ): Promise<{ docId: string | null; pdfId: string | null }> {
    this.logger.log(
      `[copyAndFillTemplate] Start: folder=${folderId}, name="${fileName}"`,
    );

    const drive = await this.getDriveClient();
    const docs = await this.getDocsClient();

    // 1. Copy template vào folder đích
    const copyRes = await drive.files.copy({
      fileId: this.TEMPLATE_DOC_ID,
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      fields: 'id',
    });

    const docId = copyRes.data.id ?? null;
    this.logger.log(`[copyAndFillTemplate] Copied template -> docId=${docId}`);

    if (!docId) {
      throw new Error('Cannot copy template document');
    }

    // 2. Replace các tag trong DOC
    const replacements = this.buildReplacements(payload);
    const requests: docs_v1.Schema$Request[] = Object.entries(replacements)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([tag, value]) => ({
        replaceAllText: {
          containsText: {
            text: tag,
            matchCase: true,
          },
          replaceText: value,
        },
      }));

    if (requests.length > 0) {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests },
      });

      this.logger.log(
        `[copyAndFillTemplate] Replaced ${requests.length} placeholders in docId=${docId}`,
      );
    } else {
      this.logger.warn(
        `[copyAndFillTemplate] No replacements generated for docId=${docId}`,
      );
    }

    // 3. Export DOC thành PDF và upload lại vào cùng folder
    const exportRes = await drive.files.export(
      {
        fileId: docId,
        mimeType: 'application/pdf',
      },
      {
        responseType: 'arraybuffer',
      },
    );

    const pdfData = exportRes.data as ArrayBuffer;
    const pdfBuffer = Buffer.from(pdfData);

    const pdfUpload = await drive.files.create({
      requestBody: {
        name: `${fileName}.pdf`,
        parents: [folderId],
        mimeType: 'application/pdf',
      },
      media: {
        mimeType: 'application/pdf',
        body: pdfBuffer,
      },
      fields: 'id',
    });

    const pdfId = pdfUpload.data.id ?? null;

    this.logger.log(
      `[copyAndFillTemplate] Uploaded PDF: pdfId=${pdfId} for docId=${docId}`,
    );

    return { docId, pdfId };
  }

  /**
   * Hàm public: tạo report cho 1 DailyNote
   * - 1 bản cho STAFF
   * - 1 bản cho INDIVIDUAL
   */
  async generateDailyNoteDocs(
    recordId: string,
    payload: MobileDailyNotePayload,
  ): Promise<{
    staff: { docId: string | null; pdfId: string | null };
    individual: { docId: string | null; pdfId: string | null };
  }> {
    const baseName = `${payload.date} - ${payload.individualName} - ${
      payload.staffName ?? payload.staffId ?? ''
    }`.trim();

    this.logger.log(
      `[generateDailyNoteDocs] START recordId=${recordId}, baseName="${baseName}"`,
    );

    try {
      const staff = await this.copyAndFillTemplate(
        this.STAFF_FOLDER_ID,
        `${baseName} (STAFF)`,
        payload,
      );

      const individual = await this.copyAndFillTemplate(
        this.INDIVIDUAL_FOLDER_ID,
        `${baseName} (INDIVIDUAL)`,
        payload,
      );

      this.logger.log(
        `[generateDailyNoteDocs] DONE recordId=${recordId}: staffPdf=${staff.pdfId}, individualPdf=${individual.pdfId}`,
      );

      return { staff, individual };
    } catch (err) {
      this.logger.error(
        `[generateDailyNoteDocs] FAILED recordId=${recordId}: ${
          (err as Error).message
        }`,
      );
      this.logger.error((err as Error).stack);
      throw err;
    }
  }
}
