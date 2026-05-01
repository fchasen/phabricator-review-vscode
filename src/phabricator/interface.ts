import type {
	Revision,
	Diff,
	Repository,
	User,
	Project,
	Transaction,
	WhoAmI,
} from '../client';

export type {
	Revision,
	Diff,
	Repository,
	User,
	Project,
	Transaction,
	WhoAmI,
};

export interface ResolvedReviewer {
	phid: string;
	displayName: string;
	isProject: boolean;
	status: 'added' | 'accepted' | 'rejected' | 'blocking' | 'resigned' | 'accepted-prior';
	isBlocking: boolean;
}

export interface ResolvedRevision {
	revision: Revision;
	author: User | undefined;
	repository: Repository | undefined;
	reviewers: ResolvedReviewer[];
}
