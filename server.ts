import express, { Request, Response } from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import {
  INITIAL_USERS,
  INITIAL_CITIZEN_PROFILE,
  INITIAL_DOCUMENTS,
  SERVICE_CATALOG,
  SERVICE_CATEGORIES,
  INITIAL_APPLICATIONS,
  INITIAL_GRIEVANCES,
  DEPARTMENT_STATS,
  MOCK_DIGILOCKER_VAULT,
} from './src/data/initialData';
import {
  Application,
  CitizenProfile,
  DocumentItem,
  Grievance,
  User,
  Role,
  DocumentType,
} from './src/types';

dotenv.config();

// Global In-Memory Store for Live Cross-Device Sync
let users: User[] = [...INITIAL_USERS];
let profiles: Record<string, CitizenProfile> = {
  'SMV-CIT-10245': { ...INITIAL_CITIZEN_PROFILE },
};
let documents: DocumentItem[] = [...INITIAL_DOCUMENTS];
let applications: Application[] = [...INITIAL_APPLICATIONS];
let grievances: Grievance[] = [...INITIAL_GRIEVANCES];
const grievanceResponseTimers = new Map<string, NodeJS.Timeout>();
const faceTemplates = new Map<string, number[]>();

// SSE Clients for instant synchronization across all devices / laptops
const sseClients: Set<Response> = new Set();

function broadcastEvent(type: string, payload: any) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch {
      sseClients.delete(client);
    }
  }
}

let geminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (!geminiClient && process.env.GEMINI_API_KEY) {
    try {
      geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    } catch (err) {
      console.warn('Gemini client init warning:', err);
    }
  }
  return geminiClient;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // SSE Endpoint for 3-Laptop Live Synchronization
  app.get('/api/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);
    res.write(`event: init\ndata: ${JSON.stringify({ message: 'Connected to Samanvay Realtime Sync' })}\n\n`);

    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  // Health
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      platform: 'Samanvay Unified Platform',
      version: '1.0.0',
      activeSyncClients: sseClients.size,
    });
  });

  // Scholarship-only camera face descriptor enrollment and verification.
  const faceDistance = (left: number[], right: number[]) => Math.sqrt(left.reduce((sum, value, index) => sum + (value - (right[index] || 0)) ** 2, 0));
  app.post('/api/auth/face/enroll', (req: Request, res: Response) => {
    const identifier = String(req.body.identifier || '').trim();
    const descriptor = Array.isArray(req.body.descriptor) ? req.body.descriptor.map(Number) : [];
    if (!identifier || descriptor.length !== 128 || descriptor.some((value: number) => !Number.isFinite(value))) {
      res.status(400).json({ success: false, error: 'A valid live face descriptor is required' });
      return;
    }
    faceTemplates.set(identifier, descriptor);
    res.json({ success: true });
  });

  app.post('/api/auth/face/verify', (req: Request, res: Response) => {
    const identifier = String(req.body.identifier || '').trim();
    const descriptor = Array.isArray(req.body.descriptor) ? req.body.descriptor.map(Number) : [];
    const enrolled = faceTemplates.get(identifier);
    if (!enrolled || descriptor.length !== 128 || descriptor.some((value: number) => !Number.isFinite(value))) {
      if (!enrolled) {
        res.status(404).json({ success: false, error: 'No face enrolled for this Scholarship account' });
        return;
      }
      res.status(401).json({ success: false, error: 'Face not recognized. Please try again.' });
      return;
    }
    const distance = faceDistance(enrolled, descriptor);
    if (distance > 0.55) {
      res.status(401).json({ success: false, error: 'Face not recognized. Please try again.' });
      return;
    }
    res.json({ success: true });
  });

  // Auth: Login
  app.post('/api/auth/login', (req: Request, res: Response) => {
    const { identifier, role } = req.body;
    let foundUser: User | undefined;

    if (role) {
      foundUser = users.find((u) => u.role === role);
    }

    if (!foundUser && identifier) {
      const cleanId = String(identifier).trim().toUpperCase();
      foundUser = users.find(
        (u) =>
          u.citizenId === cleanId ||
          u.officerId === cleanId ||
          u.higherOfficerId === cleanId ||
          u.mobile === identifier ||
          u.email?.toLowerCase() === identifier.toLowerCase()
      );
    }

    if (!foundUser) {
      // Fallback: create citizen session or return demo citizen
      foundUser = users[0];
    }

    res.json({
      success: true,
      user: foundUser,
      profile: foundUser.citizenId ? profiles[foundUser.citizenId] : null,
    });
  });

  // Auth: Sign Up
  app.post('/api/auth/signup', async (req: Request, res: Response) => {
    const {
      fullName,
      mobile,
      email,
      dateOfBirth,
      age,
      gender,
      address,
      state,
      district,
      mandal,
      pincode,
      educationLevel,
      socialCategory,
      annualFamilyIncome,
      faceDescriptor,
    } = req.body;

    const randomNum = Math.floor(10000 + Math.random() * 90000);
    const newCitizenId = `SMV-CIT-${randomNum}`;

    const newUser: User = {
      id: `user_cit_${Date.now()}`,
      role: 'CITIZEN',
      name: fullName || 'New Citizen',
      citizenId: newCitizenId,
      mobile: mobile || '9800000000',
      email: email || `${newCitizenId.toLowerCase()}@example.gov.in`,
      jurisdiction: {
        state: state || 'Andhra Pradesh',
        district: district || 'Visakhapatnam',
        mandal: mandal || 'Gajuwaka',
      },
    };

    const newProfile: CitizenProfile = {
      id: `prof_${Date.now()}`,
      citizenId: newCitizenId,
      fullName: fullName || 'New Citizen',
      dateOfBirth: dateOfBirth || '2000-01-01',
      age: Number(age) || 24,
      gender: gender || 'Female',
      mobile: mobile || '9800000000',
      email: email || `${newCitizenId.toLowerCase()}@example.gov.in`,
      address: address || 'Main Road',
      state: state || 'Andhra Pradesh',
      district: district || 'Visakhapatnam',
      mandal: mandal || 'Gajuwaka',
      pincode: pincode || '530001',
      educationLevel: educationLevel || 'Undergraduate',
      socialCategory: socialCategory || 'OBC',
      annualFamilyIncome: Number(annualFamilyIncome) || 180000,
      occupation: 'Student/Applicant',
      disabilityStatus: false,
      bankAccountLinked: true,
    };

    if (Array.isArray(faceDescriptor) && faceDescriptor.length === 128) {
      faceTemplates.set(newCitizenId, faceDescriptor.map(Number));
    }

    users.push(newUser);
    profiles[newCitizenId] = newProfile;

    // Seed default Aadhaar doc for new citizen
    const initialAadhaar: DocumentItem = {
      id: `doc_${Date.now()}`,
      citizenId: newCitizenId,
      type: 'AADHAAR',
      title: 'Aadhaar Card (UIDAI Verified)',
      documentNumber: `XXXX-XXXX-${Math.floor(1000 + Math.random() * 9000)}`,
      issuer: 'UIDAI',
      issueDate: '2020-01-01',
      source: 'DIGILOCKER',
      verified: true,
      uploadedAt: new Date().toISOString(),
    };
    documents.push(initialAadhaar);

    broadcastEvent('USER_REGISTERED', { user: newUser });

    res.status(201).json({
      success: true,
      user: newUser,
      profile: newProfile,
      citizenId: newCitizenId,
    });
  });

  // Profile Endpoints
  app.get('/api/profile/:citizenId', (req: Request, res: Response) => {
    const profile = profiles[req.params.citizenId] || profiles['SMV-CIT-10245'];
    res.json({ success: true, profile });
  });

  app.put('/api/profile/:citizenId', (req: Request, res: Response) => {
    const { citizenId } = req.params;
    const existing = profiles[citizenId] || profiles['SMV-CIT-10245'];
    const updated = { ...existing, ...req.body, citizenId };
    profiles[citizenId] = updated;
    const userIndex = users.findIndex((user) => user.citizenId === citizenId);
    if (userIndex >= 0) users[userIndex] = { ...users[userIndex], name: updated.fullName };

    broadcastEvent('PROFILE_UPDATED', { profile: updated });
    res.json({ success: true, profile: updated });
  });

  // Services Catalog
  app.get('/api/services', (_req: Request, res: Response) => {
    res.json({
      success: true,
      categories: SERVICE_CATEGORIES,
      services: SERVICE_CATALOG,
    });
  });

  // Smart Eligibility Rules Engine
  app.post('/api/eligibility/check', (req: Request, res: Response) => {
    const { serviceId, citizenId } = req.body;
    const service = SERVICE_CATALOG.find((s) => s.id === serviceId);
    const profile = profiles[citizenId] || profiles['SMV-CIT-10245'];

    if (!service) {
      res.status(404).json({ success: false, error: 'Service not found' });
      return;
    }

    const ruleEvaluations: Array<{
      ruleId: string;
      description: string;
      passed: boolean;
      field: string;
      expected: any;
      actual: any;
      reason: string;
    }> = [];

    let isEligible = true;

    for (const rule of service.eligibilityRules) {
      const actualValue = (profile as any)[rule.field];
      let passed = true;
      let reason = 'Criteria satisfied';

      if (rule.operator === 'lte') {
        passed = Number(actualValue) <= Number(rule.value);
        if (!passed) {
          reason = `Current ${rule.field} (₹${Number(actualValue).toLocaleString('en-IN')}) exceeds maximum limit of ₹${Number(rule.value).toLocaleString('en-IN')}`;
        }
      } else if (rule.operator === 'gte') {
        passed = Number(actualValue) >= Number(rule.value);
        if (!passed) {
          reason = `Current ${rule.field} (${actualValue}) is below minimum requirement of ${rule.value}`;
        }
      } else if (rule.operator === 'eq') {
        passed = String(actualValue).toLowerCase() === String(rule.value).toLowerCase();
        if (!passed) {
          reason = `Required: ${rule.value}, Current: ${actualValue}`;
        }
      } else if (rule.operator === 'in') {
        const allowed = Array.isArray(rule.value) ? rule.value : [rule.value];
        passed = allowed.map((v) => String(v).toLowerCase()).includes(String(actualValue).toLowerCase());
        if (!passed) {
          reason = `Applicable for categories [${allowed.join(', ')}]. Current: ${actualValue}`;
        }
      }

      if (!passed) isEligible = false;

      ruleEvaluations.push({
        ruleId: rule.id,
        description: rule.description,
        passed,
        field: String(rule.field),
        expected: rule.value,
        actual: actualValue,
        reason,
      });
    }

    // Document comparison for required vs existing
    const citizenDocs = documents.filter((d) => d.citizenId === citizenId || d.citizenId === 'SMV-CIT-10245');
    const existingTypes = new Set(citizenDocs.map((d) => d.type));

    const documentStatus = service.requiredDocumentTypes.map((docType) => {
      const doc = citizenDocs.find((d) => d.type === docType);
      return {
        type: docType,
        available: !!doc,
        documentItem: doc || null,
      };
    });

    const availableCount = documentStatus.filter((d) => d.available).length;
    const missingCount = documentStatus.filter((d) => !d.available).length;

    res.json({
      success: true,
      isEligible,
      ruleEvaluations,
      documentStatus,
      availableCount,
      missingCount,
      totalRequired: service.requiredDocumentTypes.length,
      service,
      profile,
    });
  });

  // Documents Endpoints
  app.get('/api/documents/:citizenId', (req: Request, res: Response) => {
    const { citizenId } = req.params;
    const userDocs = documents.filter((d) => d.citizenId === citizenId || d.citizenId === 'SMV-CIT-10245');
    res.json({ success: true, documents: userDocs });
  });

  app.post('/api/documents/upload', (req: Request, res: Response) => {
    const { citizenId, type, title, source, documentNumber, issuer, extractedDetails } = req.body;

    const newDoc: DocumentItem = {
      id: `doc_${Date.now()}`,
      citizenId: citizenId || 'SMV-CIT-10245',
      type: (type as DocumentType) || 'INCOME_CERTIFICATE',
      title: title || `${type} (Uploaded & Verified)`,
      documentNumber: documentNumber || `SMV-DOC-${Math.floor(10000 + Math.random() * 90000)}`,
      issuer: issuer || 'Authorized Issuing Authority',
      issueDate: new Date().toISOString().split('T')[0],
      source: source || 'CAMERA_SCAN',
      verified: true,
      uploadedAt: new Date().toISOString(),
      extractedDetails: extractedDetails || {
        Status: 'Verified via Samanvay Visual Engine',
        Confidence: '99.4%',
      },
    };

    // Replace if same type exists or add new
    const idx = documents.findIndex((d) => d.citizenId === newDoc.citizenId && d.type === newDoc.type);
    if (idx >= 0) {
      documents[idx] = newDoc;
    } else {
      documents.push(newDoc);
    }

    broadcastEvent('DOCUMENT_ADDED', { document: newDoc });
    res.status(201).json({ success: true, document: newDoc });
  });

  // Mock DigiLocker Fetch
  app.get('/api/documents/mock-digilocker/vault', (_req: Request, res: Response) => {
    res.json({ success: true, vault: MOCK_DIGILOCKER_VAULT });
  });

  app.post('/api/documents/mock-digilocker/fetch', (req: Request, res: Response) => {
    const { citizenId, docType } = req.body;
    const vaultItem = MOCK_DIGILOCKER_VAULT.find((v) => v.type === docType);

    const newDoc: DocumentItem = {
      id: `doc_${Date.now()}`,
      citizenId: citizenId || 'SMV-CIT-10245',
      type: (docType as DocumentType) || 'CASTE_CERTIFICATE',
      title: vaultItem ? vaultItem.title : `${docType} (DigiLocker Verified)`,
      documentNumber: vaultItem ? vaultItem.documentNumber : `DL-${Math.floor(100000 + Math.random() * 900000)}`,
      issuer: vaultItem ? vaultItem.issuer : 'DigiLocker / National e-Governance Division',
      issueDate: vaultItem ? vaultItem.issueDate : '2025-01-15',
      source: 'DIGILOCKER',
      verified: true,
      uploadedAt: new Date().toISOString(),
      extractedDetails: vaultItem
        ? Object.fromEntries(Object.entries(vaultItem).filter(([, value]) => value !== undefined))
        : {
        SecurityStatus: 'Digitally Signed by Govt PKI Root Certificate',
          },
    };

    const idx = documents.findIndex((d) => d.citizenId === newDoc.citizenId && d.type === newDoc.type);
    if (idx >= 0) {
      documents[idx] = newDoc;
    } else {
      documents.push(newDoc);
    }

    broadcastEvent('DOCUMENT_ADDED', { document: newDoc });
    res.json({ success: true, document: newDoc });
  });

  // Applications Endpoints
  app.get('/api/applications', (req: Request, res: Response) => {
    const { citizenId, officerId } = req.query;
    let list = [...applications];

    if (citizenId) {
      list = list.filter((a) => a.citizenId === citizenId || a.citizenId === 'SMV-CIT-10245');
    } else if (officerId) {
      list = list.filter((a) => a.assignedOfficerId === officerId || !a.assignedOfficerId);
    }

    // Sort newest first
    list.sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
    res.json({ success: true, applications: list });
  });

  app.post('/api/applications', (req: Request, res: Response) => {
    const { serviceId, citizenId } = req.body;
    const service = SERVICE_CATALOG.find((s) => s.id === serviceId);
    const profile = profiles[citizenId] || profiles['SMV-CIT-10245'];

    if (!service) {
      res.status(404).json({ success: false, error: 'Service not found' });
      return;
    }

    const randomAppNum = Math.floor(1000 + Math.random() * 9000);
    const appId = `SMV-APP-2026-${randomAppNum}`;

    const userDocs = documents.filter((d) => d.citizenId === citizenId || d.citizenId === 'SMV-CIT-10245');
    const attachedIds = userDocs.map((d) => d.id);

    const newApp: Application = {
      id: appId,
      serviceId: service.id,
      serviceTitle: service.title,
      department: service.department,
      citizenId: profile.citizenId,
      citizenName: profile.fullName,
      citizenMobile: profile.mobile,
      citizenIncome: profile.annualFamilyIncome,
      citizenCategory: profile.socialCategory,
      citizenDistrict: profile.district,
      citizenMandal: profile.mandal,
      submittedAt: new Date().toISOString(),
      status: 'SUBMITTED',
      assignedOfficerId: 'SMV-OFF-204',
      assignedOfficerName: 'Ravi Kumar',
      attachedDocumentIds: attachedIds,
      timeline: [
        {
          status: 'SUBMITTED',
          timestamp: new Date().toISOString(),
          actor: `Citizen (${profile.fullName})`,
          remarks: `Application submitted with ${attachedIds.length} verified documents from Samanvay Locker.`,
        },
        {
          status: 'UNDER_VERIFICATION',
          timestamp: new Date().toISOString(),
          actor: 'Samanvay Intelligent Router',
          remarks: `Auto-routed to ${service.department} — Assigned to Officer Ravi Kumar.`,
        },
      ],
      benefitDetails: service.benefits,
      updatedAt: new Date().toISOString(),
    };

    applications.unshift(newApp);
    broadcastEvent('APPLICATION_CREATED', { application: newApp });

    res.status(201).json({ success: true, application: newApp });
  });

  // Officer Update Application Status (Approve / Reject / Under Verification)
  app.patch('/api/applications/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const { status, remarks, actorName, actorRole } = req.body;
    const appIndex = applications.findIndex((a) => a.id === id);

    if (appIndex === -1) {
      res.status(404).json({ success: false, error: 'Application not found' });
      return;
    }

    if (status === 'APPROVED' && actorRole !== 'HIGHER_OFFICER') {
      res.status(403).json({ success: false, error: 'Only a Higher Officer can approve and sanction an application.' });
      return;
    }

    const current = applications[appIndex];
    const newTimelineEvent = {
      status,
      timestamp: new Date().toISOString(),
      actor: actorName || 'Officer Ravi Kumar',
      remarks: remarks || `Status updated to ${status}`,
    };

    const updatedApp: Application = {
      ...current,
      status,
      officerRemarks: remarks || current.officerRemarks,
      timeline: [...current.timeline, newTimelineEvent],
      updatedAt: new Date().toISOString(),
    };

    // If approved, trigger final benefit disbursement step in timeline
    if (status === 'APPROVED') {
      updatedApp.timeline.push({
        status: 'BENEFIT_DISBURSED',
        timestamp: new Date().toISOString(),
        actor: 'Direct Benefit Transfer (DBT) Gateway',
        remarks: 'Digital authorization order transmitted to treasury for DBT credit.',
      });
    }

    applications[appIndex] = updatedApp;
    broadcastEvent('APPLICATION_UPDATED', { application: updatedApp });

    res.json({ success: true, application: updatedApp });
  });

  app.post('/api/applications/:id/escalate', (req: Request, res: Response) => {
    const appIndex = applications.findIndex((item) => item.id === req.params.id);
    if (appIndex === -1) {
      res.status(404).json({ success: false, error: 'Application not found' });
      return;
    }
    const current = applications[appIndex];
    const updatedApp: Application = {
      ...current,
      status: 'ESCALATED',
      officerRemarks: req.body.remarks || current.officerRemarks,
      timeline: [...current.timeline, {
        status: 'ESCALATED',
        timestamp: new Date().toISOString(),
        actor: req.body.actorName || 'Public Services Officer',
        remarks: req.body.remarks || 'Application escalated to Higher Officer for final review.',
      }],
      updatedAt: new Date().toISOString(),
    };
    applications[appIndex] = updatedApp;
    broadcastEvent('APPLICATION_ESCALATED', { application: updatedApp });
    res.json({ success: true, application: updatedApp });
  });

  // Grievances Endpoints
  app.get('/api/grievances', (req: Request, res: Response) => {
    const { citizenId, officerId } = req.query;
    let list = [...grievances];

    if (citizenId) {
      list = list.filter((g) => g.citizenId === citizenId || g.citizenId === 'SMV-CIT-10245');
    } else if (officerId) {
      list = list.filter((g) => g.assignedOfficerId === officerId || !g.assignedOfficerId);
    }

    list.sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
    res.json({ success: true, grievances: list });
  });

  // Smart Grievance Submission with Automatic Routing
  app.post('/api/grievances', (req: Request, res: Response) => {
    const {
      citizenId,
      category,
      issueType,
      description,
      state,
      district,
      mandal,
      landmark,
      coordinates,
      voiceNoteUrl,
      photoUrl,
      allowDuplicate,
    } = req.body;

    const normalized = (value: string) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const duplicate = grievances.find((grievance) =>
      grievance.citizenId === citizenId &&
      grievance.category === category &&
      normalized(grievance.location.state) === normalized(state) &&
      normalized(grievance.location.district) === normalized(district) &&
      normalized(grievance.location.mandal) === normalized(mandal) &&
      normalized(grievance.description) === normalized(description) &&
      Date.now() - new Date(grievance.submittedAt).getTime() < 24 * 60 * 60 * 1000
    );
    if (duplicate && !allowDuplicate) {
      res.status(409).json({ success: false, duplicate: true, existingGrievance: duplicate });
      return;
    }

    const profile = profiles[citizenId] || profiles['SMV-CIT-10245'];
    let grievanceId = '';
    do {
      const randomGrvNum = Math.floor(1000 + Math.random() * 9000);
      grievanceId = `SMV-GRV-2026-${randomGrvNum}`;
    } while (grievances.some((grievance) => grievance.id === grievanceId));

    // Auto-Routing Engine based on category and jurisdiction
    let routedDepartment = 'Municipal Administration & Civic Works';
    if (category.includes('Water') || category.includes('Sanitation')) {
      routedDepartment = 'Municipal Water Supply & Sewerage Board';
    } else if (category.includes('Electricity') || category.includes('Streetlight')) {
      routedDepartment = 'Energy & Municipal Electrical Engineering';
    } else if (category.includes('Road') || category.includes('Infrastructure')) {
      routedDepartment = 'Roads & Buildings / Municipal Engineering';
    } else if (category.includes('Ration') || category.includes('Food')) {
      routedDepartment = 'Department of Civil Supplies';
    } else if (category.includes('Pension') || category.includes('Scholarship') || category.includes('Welfare')) {
      routedDepartment = 'Department of Social Welfare';
    }

    const submittedAt = new Date().toISOString();
    const slaDueDate = new Date(new Date(submittedAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const newGrievance: Grievance = {
      id: grievanceId,
      followUpReference: `SMV-FUP-${Math.floor(100000 + Math.random() * 900000)}`,
      citizenId: profile.citizenId,
      citizenName: profile.fullName,
      citizenMobile: profile.mobile,
      category: category || 'Civic Infrastructure',
      issueType: issueType || 'Public Civic Grievance',
      description: description || 'Local issue reported via Samanvay.',
      location: {
        state: state || profile.state,
        district: district || profile.district,
        mandal: mandal || profile.mandal,
        landmark: landmark || 'Local Area',
        coordinates,
      },
      routedDepartment,
      assignedOfficerId: 'SMV-OFF-204',
      assignedOfficerName: 'Ravi Kumar',
      status: 'SUBMITTED',
      slaDays: 7,
      slaDueDate,
      isSlaBreached: false,
      voiceNoteUrl,
      photoUrl,
      timeline: [
        {
          status: 'SUBMITTED',
          timestamp: submittedAt,
          actor: `Citizen (${profile.fullName})`,
          remarks: 'Grievance submitted with location jurisdiction and description.',
        },
        {
          status: 'RECEIVED',
          timestamp: submittedAt,
          actor: 'Samanvay Intelligent Auto-Routing Engine',
          remarks: `Geographically routed to ${district} -> ${mandal} -> ${routedDepartment}. Assigned to Officer Ravi Kumar.`,
        },
        {
          status: 'ASSIGNED',
          timestamp: submittedAt,
          actor: 'Samanvay Intelligent Auto-Routing Engine',
          remarks: 'Assigned to Officer Ravi Kumar (SMV-OFF-204). 5-minute response timer started.',
        },
      ],
      submittedAt,
      updatedAt: submittedAt,
    };

    grievances.unshift(newGrievance);
    broadcastEvent('GRIEVANCE_CREATED', { grievance: newGrievance });

    grievanceResponseTimers.set(
      grievanceId,
      setTimeout(() => {
        const index = grievances.findIndex((grievance) => grievance.id === grievanceId);
        const current = grievances[index];
        if (!current || current.status !== 'SUBMITTED') return;

        const escalatedGrievance: Grievance = {
          ...current,
          assignedOfficerId: 'SMV-HO-301',
          assignedOfficerName: 'Priya Sharma',
          status: 'ESCALATED',
          isSlaBreached: true,
          escalationLevel: 'HIGHER_OFFICER',
          escalationReason: 'Automatically Escalated — No Officer Response Within 5 Minutes.',
          timeline: [...current.timeline, {
            status: 'ESCALATED',
            timestamp: new Date().toISOString(),
            actor: 'Samanvay Automatic Response Watchdog',
            remarks: 'Automatically Escalated — No Officer Response Within 5 Minutes. Assigned to Higher Officer Priya Sharma (SMV-HO-301).',
          }],
          updatedAt: new Date().toISOString(),
        };
        grievances[index] = escalatedGrievance;
        grievanceResponseTimers.delete(grievanceId);
        broadcastEvent('GRIEVANCE_ESCALATED', { grievance: escalatedGrievance });
      }, 5 * 60 * 1000)
    );

    res.status(201).json({ success: true, grievance: newGrievance });
  });

  // Prototype-only complaint reset; applications, profiles and documents remain untouched.
  app.post('/api/grievances/demo/reset', (_req: Request, res: Response) => {
    grievances = [];
    broadcastEvent('GRIEVANCES_RESET', { scope: 'prototype-complaints' });
    res.json({ success: true });
  });

  // Officer Update Grievance Status
  app.patch('/api/grievances/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const { status, remarks, actorName } = req.body;
    const grvIndex = grievances.findIndex((g) => g.id === id);

    if (grvIndex === -1) {
      res.status(404).json({ success: false, error: 'Grievance not found' });
      return;
    }

    const current = grievances[grvIndex];
    const responseTimer = grievanceResponseTimers.get(id);
    if (responseTimer) {
      clearTimeout(responseTimer);
      grievanceResponseTimers.delete(id);
    }
    const newTimelineEvent = {
      status,
      timestamp: new Date().toISOString(),
      actor: actorName || 'Officer Ravi Kumar',
      remarks: remarks || `Status transitioned to ${status}`,
    };

    const updatedGrievance: Grievance = {
      ...current,
      status,
      officerRemarks: remarks || current.officerRemarks,
      timeline: [...current.timeline, newTimelineEvent],
      updatedAt: new Date().toISOString(),
    };

    grievances[grvIndex] = updatedGrievance;
    broadcastEvent('GRIEVANCE_UPDATED', { grievance: updatedGrievance });

    res.json({ success: true, grievance: updatedGrievance });
  });

  app.post('/api/grievances/:id/forward', (req: Request, res: Response) => {
    const grvIndex = grievances.findIndex((grievance) => grievance.id === req.params.id);
    if (grvIndex === -1) {
      res.status(404).json({ success: false, error: 'Grievance not found' });
      return;
    }
    const timer = grievanceResponseTimers.get(req.params.id);
    if (timer) {
      clearTimeout(timer);
      grievanceResponseTimers.delete(req.params.id);
    }
    const current = grievances[grvIndex];
    const updatedGrievance: Grievance = {
      ...current,
      assignedOfficerId: 'SMV-HO-301',
      assignedOfficerName: 'Priya Sharma',
      status: 'ESCALATED',
      escalationLevel: 'HIGHER_OFFICER',
      escalationReason: 'Forwarded after Officer verification.',
      timeline: [...current.timeline, {
        status: 'ESCALATED',
        timestamp: new Date().toISOString(),
        actor: req.body.actorName || 'Grievance Officer',
        remarks: req.body.remarks || 'Complaint verified and forwarded to Higher Officer.',
      }],
      updatedAt: new Date().toISOString(),
    };
    grievances[grvIndex] = updatedGrievance;
    broadcastEvent('GRIEVANCE_ESCALATED', { grievance: updatedGrievance });
    res.json({ success: true, grievance: updatedGrievance });
  });

  // Live Demo Feature: Simulate SLA Breach & Auto-Escalate
  app.post('/api/grievances/:id/simulate-breach', (req: Request, res: Response) => {
    const { id } = req.params;
    const grvIndex = grievances.findIndex((g) => g.id === id);

    if (grvIndex === -1) {
      res.status(404).json({ success: false, error: 'Grievance not found' });
      return;
    }

    const current = grievances[grvIndex];
    const responseTimer = grievanceResponseTimers.get(id);
    if (responseTimer) {
      clearTimeout(responseTimer);
      grievanceResponseTimers.delete(id);
    }
    const breachTimelineEvent = {
      status: 'ESCALATED' as const,
      timestamp: new Date().toISOString(),
      actor: 'Samanvay Smart SLA Watchdog Engine',
      remarks: 'Automatically Escalated — No Officer Response Within 5 Minutes. Assigned to Higher Officer Priya Sharma (SMV-HO-301).',
    };

    const updatedGrievance: Grievance = {
      ...current,
      assignedOfficerId: 'SMV-HO-301',
      assignedOfficerName: 'Priya Sharma',
      status: 'ESCALATED',
      isSlaBreached: true,
      escalationLevel: 'HIGHER_OFFICER',
      escalationReason: 'Automatically Escalated — No Officer Response Within 5 Minutes.',
      timeline: [...current.timeline, breachTimelineEvent],
      updatedAt: new Date().toISOString(),
    };

    grievances[grvIndex] = updatedGrievance;
    broadcastEvent('GRIEVANCE_ESCALATED', { grievance: updatedGrievance });

    res.json({ success: true, grievance: updatedGrievance });
  });

  // Higher Officer Direct Intervention & Resolution
  app.post('/api/grievances/:id/higher-officer-intervention', (req: Request, res: Response) => {
    const { id } = req.params;
    const { action, notes } = req.body;
    const grvIndex = grievances.findIndex((g) => g.id === id);

    if (grvIndex === -1) {
      res.status(404).json({ success: false, error: 'Grievance not found' });
      return;
    }

    const current = grievances[grvIndex];
    let newStatus = current.status;
    let remarks = notes || 'Executive review completed by Higher Authority.';

    if (action === 'RESOLVE') {
      newStatus = 'RESOLVED';
      remarks = notes || 'Expedited resolution ordered and verified by Joint Secretary Priya Sharma.';
    } else if (action === 'DIRECTIVE') {
      newStatus = 'IN_PROGRESS';
      remarks = `Priority Directive Issued to Field Staff: ${notes || 'Immediate 24-hour compliance mandated.'}`;
    }

    const timelineEvent = {
      status: newStatus,
      timestamp: new Date().toISOString(),
      actor: 'Joint Secretary Priya Sharma (Higher Officer)',
      remarks,
    };

    const updatedGrievance: Grievance = {
      ...current,
      status: newStatus,
      higherOfficerNotes: notes || current.higherOfficerNotes,
      timeline: [...current.timeline, timelineEvent],
      updatedAt: new Date().toISOString(),
    };

    grievances[grvIndex] = updatedGrievance;
    broadcastEvent('GRIEVANCE_UPDATED', { grievance: updatedGrievance });

    res.json({ success: true, grievance: updatedGrievance });
  });

  // Higher Officer Stats & District Analytics
  app.get('/api/stats', (_req: Request, res: Response) => {
    const totalApps = applications.length;
    const pendingApps = applications.filter((a) => a.status === 'SUBMITTED' || a.status === 'UNDER_VERIFICATION' || a.status === 'OFFICER_ASSIGNED').length;
    const approvedApps = applications.filter((a) => a.status === 'APPROVED' || a.status === 'BENEFIT_DISBURSED').length;
    const rejectedApps = applications.filter((a) => a.status === 'REJECTED').length;

    const totalGrvs = grievances.length;
    const pendingGrvs = grievances.filter((g) => g.status === 'SUBMITTED' || g.status === 'RECEIVED' || g.status === 'IN_PROGRESS').length;
    const resolvedGrvs = grievances.filter((g) => g.status === 'RESOLVED').length;
    const escalatedGrvs = grievances.filter((g) => g.status === 'ESCALATED').length;
    const slaBreaches = grievances.filter((g) => g.isSlaBreached).length;

    res.json({
      success: true,
      summary: {
        totalApplications: totalApps + 8420, // realistic overall state figure
        pendingApplications: pendingApps + 142,
        approvedApplications: approvedApps + 8150,
        rejectedApplications: rejectedApps + 128,
        totalGrievances: totalGrvs + 940,
        pendingGrievances: pendingGrvs + 86,
        resolvedGrievances: resolvedGrvs + 810,
        escalatedGrievances: escalatedGrvs + 14,
        slaBreaches: slaBreaches + 14,
        activeCitizensRegistered: 48920,
        averageTurnaroundDays: 4.8,
      },
      departments: DEPARTMENT_STATS,
      districtBreakdown: [
        { district: 'Visakhapatnam', applications: 2840, grievances: 180, slaBreaches: 3, performanceScore: 96 },
        { district: 'Krishna / Vijayawada', applications: 2410, grievances: 140, slaBreaches: 2, performanceScore: 97 },
        { district: 'Guntur', applications: 1980, grievances: 195, slaBreaches: 4, performanceScore: 92 },
        { district: 'East Godavari', applications: 1820, grievances: 120, slaBreaches: 1, performanceScore: 98 },
        { district: 'Tirupati / Chittoor', applications: 1650, grievances: 165, slaBreaches: 5, performanceScore: 90 },
      ],
    });
  });

  // Voice Speech-To-Intent Engine (with Gemini API / Rule Fallback)
  app.post('/api/voice/intent', async (req: Request, res: Response) => {
    const { transcript, language } = req.body;
    const text = String(transcript || '').trim();
    const lower = text.toLowerCase();

    // Resolve common Telugu and mixed-language civic phrases before the optional AI parser.
    const teluguComplaintPatterns: Array<{ pattern: RegExp; intent: string; category: string; summary: string }> = [
      {
        pattern: /\u0c35\u0c3f\u0c26\u0c4d\u0c2f\u0c41\u0c24\u0c4d|\u0c15\u0c30\u0c46\u0c02\u0c1f\u0c4d|\u0c2a\u0c35\u0c30\u0c4d|\u0c2a\u0c35\u0c30\u0c4d\s*\u0c15\u0c1f\u0c4d|current|power\s*cut|electricity|street\s*light|\u0c35\u0c40\u0c27\u0c3f\s*\u0c26\u0c40\u0c2a|\u0c32\u0c48\u0c1f\u0c41|\u0c32\u0c48\u0c1f/iu,
        intent: 'GRIEVANCE_ELECTRICITY',
        category: 'Electricity & Streetlighting',
        summary: 'Identified Electricity / Streetlight issue.',
      },
      {
        pattern: /\u0c28\u0c40\u0c1f\u0c3f|\u0c28\u0c40\u0c30\u0c41|\u0c24\u0c3e\u0c17\u0c41\u0c28\u0c40\u0c30\u0c41|\u0c28\u0c40\u0c1f\u0c3f\s*\u0c38\u0c30\u0c2b\u0c30\u0c3e|water|pipeline|\u0c2a\u0c48\u0c2a\u0c4d|\u0c2a\u0c48\u0c2a\u0c41\u0c32/iu,
        intent: 'GRIEVANCE_WATER',
        category: 'Water Supply & Sanitation',
        summary: 'Identified Water Supply Grievance.',
      },
      {
        pattern: /\u0c30\u0c4b\u0c21\u0c4d\u0c21\u0c41|\u0c30\u0c39\u0c26\u0c3e\u0c30\u0c3f|\u0c17\u0c41\u0c02\u0c24|road|pothole|\u0c38\u0c21\u0c15/iu,
        intent: 'GRIEVANCE_ROAD',
        category: 'Roads & Infrastructure',
        summary: 'Identified Road Repair Grievance.',
      },
      {
        pattern: /\u0c1a\u0c46\u0c24\u0c4d\u0c24|\u0c2a\u0c3e\u0c30\u0c3f\u0c36\u0c41\u0c27\u0c4d\u0c2f|\u0c15\u0c3e\u0c32\u0c41\u0c35|\u0c2e\u0c41\u0c30\u0c41\u0c17\u0c41|\u0c38\u0c3e\u0c28\u0c3f\u0c1f\u0c47\u0c37\u0c28\u0c4d|garbage|sanitation|drain|sewage/iu,
        intent: 'GRIEVANCE_DRAINAGE',
        category: 'Drainage & Public Health',
        summary: 'Identified Sanitation Grievance.',
      },
    ];

    const matchedComplaint = teluguComplaintPatterns.find(({ pattern }) => pattern.test(text));
    if (matchedComplaint) {
      res.json({
        success: true,
        result: {
          intent: matchedComplaint.intent,
          targetModule: 'GRIEVANCES',
          serviceId: null,
          grievanceCategory: matchedComplaint.category,
          confidence: 0.98,
          summary: matchedComplaint.summary,
        },
      });
      return;
    }

    const client = getGeminiClient();
    if (client && text.length > 2) {
      try {
        const response = await client.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: `You are Samanvay's Indian Civic Service Intent Parser.
Input text from citizen (Language: ${language || 'any'}): "${text}"

Available actions:
1. "SCHOLARSHIP" -> Target: public-services / Education & Scholarships
2. "INCOME_CERTIFICATE" -> Target: public-services / Certificates / Income
3. "CASTE_CERTIFICATE" -> Target: public-services / Certificates / Caste
4. "HEALTH_CARD" -> Target: public-services / Health
5. "HOUSING" -> Target: public-services / Housing
6. "PENSION" -> Target: public-services / Pension
7. "RATION" -> Target: public-services / Food & Ration
8. "GRIEVANCE_WATER" -> Target: grievances / Water Supply
9. "GRIEVANCE_ELECTRICITY" -> Target: grievances / Streetlight & Electricity
10. "GRIEVANCE_ROAD" -> Target: grievances / Road Repair & Infrastructure
11. "GENERAL_GRIEVANCE" -> Target: grievances

Respond ONLY in valid JSON format:
{
  "intent": "SCHOLARSHIP" | "GRIEVANCE_WATER" | etc.,
  "targetModule": "SERVICES" | "GRIEVANCES",
  "serviceId": "srv-post-matric-scholarship" or null,
  "grievanceCategory": "Water Supply & Sanitation" or null,
  "confidence": 0.95,
  "summary": "Brief explanation in English"
}`,
          config: {
            responseMimeType: 'application/json',
          },
        });

        if (response.text) {
          const parsed = JSON.parse(response.text);
          res.json({ success: true, result: parsed });
          return;
        }
      } catch (err) {
        console.warn('Gemini intent parse fallback:', err);
      }
    }

    // High Quality Pattern Fallback for 5 Languages
    let result = {
      intent: 'SCHOLARSHIP',
      targetModule: 'SERVICES',
      serviceId: 'srv-post-matric-scholarship' as string | null,
      grievanceCategory: null as string | null,
      confidence: 0.9,
      summary: 'Navigating to Post-Matric Scholarship service.',
    };

    if (
      lower.includes('స్కాలర్') ||
      lower.includes('scholarship') ||
      lower.includes('छात्रवृत्ति') ||
      lower.includes('स्कॉलरशिप') ||
      lower.includes('शिष्यवृत्ती') ||
      lower.includes('கல்வி உதவி')
    ) {
      result = {
        intent: 'SCHOLARSHIP',
        targetModule: 'SERVICES',
        serviceId: 'srv-post-matric-scholarship',
        grievanceCategory: null,
        confidence: 0.98,
        summary: 'Identified Education & Scholarship intent.',
      };
    } else if (
      lower.includes('నీరు') ||
      lower.includes('water') ||
      lower.includes('పైప్') ||
      lower.includes('पानी') ||
      lower.includes('पाणी') ||
      lower.includes('தண்ணீர்')
    ) {
      result = {
        intent: 'GRIEVANCE_WATER',
        targetModule: 'GRIEVANCES',
        serviceId: null,
        grievanceCategory: 'Water Supply & Sanitation',
        confidence: 0.95,
        summary: 'Identified Water Supply Grievance.',
      };
    } else if (
      lower.includes('లైట్') ||
      lower.includes('light') ||
      lower.includes('करंट') ||
      lower.includes('बिजली') ||
      lower.includes('दिवा') ||
      lower.includes('மின்சாரம்')
    ) {
      result = {
        intent: 'GRIEVANCE_ELECTRICITY',
        targetModule: 'GRIEVANCES',
        serviceId: null,
        grievanceCategory: 'Electricity & Streetlighting',
        confidence: 0.95,
        summary: 'Identified Electricity / Streetlight issue.',
      };
    } else if (
      lower.includes('రోడ్డు') ||
      lower.includes('road') ||
      lower.includes('సడక్') ||
      lower.includes('सड़क') ||
      lower.includes('रस्ता') ||
      lower.includes('சாலை')
    ) {
      result = {
        intent: 'GRIEVANCE_ROAD',
        targetModule: 'GRIEVANCES',
        serviceId: null,
        grievanceCategory: 'Roads & Infrastructure',
        confidence: 0.94,
        summary: 'Identified Road Repair Grievance.',
      };
    } else if (
      lower.includes('ఆదాయ') ||
      lower.includes('income') ||
      lower.includes('आय') ||
      lower.includes('उत्पन्न') ||
      lower.includes('வருமானம்')
    ) {
      result = {
        intent: 'INCOME_CERTIFICATE',
        targetModule: 'SERVICES',
        serviceId: 'srv-income-certificate',
        grievanceCategory: null,
        confidence: 0.96,
        summary: 'Identified Income Certificate service.',
      };
    } else if (
      lower.includes('పింఛను') ||
      lower.includes('pension') ||
      lower.includes('पेंशन') ||
      lower.includes('पेन्शन') ||
      lower.includes('ஓய்வூதியம்')
    ) {
      result = {
        intent: 'PENSION',
        targetModule: 'SERVICES',
        serviceId: 'srv-old-age-pension',
        grievanceCategory: null,
        confidence: 0.95,
        summary: 'Identified Senior Citizen Pension service.',
      };
    }

    res.json({ success: true, result });
  });

  // Clear demo workflow data while preserving users, profiles, and services.
  app.post('/api/demo/reset', (_req: Request, res: Response) => {
    grievanceResponseTimers.forEach((timer) => clearTimeout(timer));
    grievanceResponseTimers.clear();
    faceTemplates.clear();
    users = [...INITIAL_USERS];
    profiles = { 'SMV-CIT-10245': { ...INITIAL_CITIZEN_PROFILE } };
    documents = [];
    applications = [];
    grievances = [];

    broadcastEvent('STATE_RESET', { message: 'Demo Workflow Data Cleared' });
    res.json({ success: true, message: 'Applications, complaints, and documents cleared' });
  });

  // Vite middleware for development vs static dist for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Samanvay Full-Stack Server running on port ${PORT}`);
    console.log(`🌐 Open Samanvay: http://localhost:${PORT}`);
  });
}

startServer();
