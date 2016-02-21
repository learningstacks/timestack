import * as UUID from 'node-uuid';
import * as Please from 'pleasejs';

export class Pouch {
	constructor() {
		this.db = null;
		this.init();
	}

	init() {
		//PouchDB.debug.enable('*');
		//PouchDB.debug.disable();

		this.db = new PouchDB('timestack');
		this.db.info().then( info => {
  			console.log('We have a database: ' + JSON.stringify(info));
		});
	}

	getUUID() {
		return UUID.v4();
	}


	/*******************************************************************

						PROJECTS

	********************************************************************/
	createProject( name ) {
		return this.db.get('project-' + name).catch( err => {
		  	if (err.status === 404) {
		    	return {	
		      		_id: 'project-' + name,
		      		name: name,
		      		type: 'project',
		      		color: Please.make_color()[0]
		    	};
		  	} else {
		    	throw err;
		  	}
		}).then( projectDoc => {
		  	return this.db.put( projectDoc ).then( result => {
		  		return projectDoc;
		  	});
		}).catch( err => {
			console.error( err );
		  	return null;
		});
	}

	updateProject( project ) {
		return this.db.get(project._id).then( projectDoc => {
			project._rev = projectDoc._rev;
		  	return this.db.put( project ).then( result => {
		  		return project;
		  	});
		}).catch( err => {
			console.error( err );
		  	return null;
		});
	}

	removeProject( project ) {
		return this.db.get(project._id).then( doc => {
  			return this.db.remove(doc);
		});
	}

	getProjects() {
		return this.db.allDocs({include_docs: true}).then( result => {
			return result.rows.filter( row => {
				if( !row.doc.type ) {
					return false;
				} else {
					return row.doc.type === 'project';
				}
			});
		});
	}

	getProject( id ) {
		return this.db.get(id).then( result => {
			return result;
		}).catch( error => {
			console.error( error );
		});
	}

	/*******************************************************************

						TASKS

	********************************************************************/
	getTasks() {
		return this.db.allDocs({include_docs: true}).then( result => {
			return result.rows.filter( row => {
				if( !row.doc.type ) {
					return false;
				} else {
					return row.doc.type === 'task';
				}
			});
		});
	}

	removeTask( task ) {
		return this.db.get(task._id).then( doc => {
  			return this.db.remove(doc);
		});
	}

	updateTask( task ) {
		return this.db.get(task._id).then( taskDoc => {
			task._rev = taskDoc._rev;
		  	return this.db.put( task ).then( result => {
		  		return task;
		  	});
		}).catch( err => {
			console.error( err );
		  	return null;
		});
	}

	createTask( name, desc, project_id, start_time ) {
		if( !name ) {
			throw new Error('New tasks require a name');
		}

		return this.db.get('task-' + name).catch( err => {
		  	if (err.status === 404) {
		    	return {	
		      		_id: 'task-' + name,
		      		name: name,
		      		type: 'task',
		      		desc: desc,
		      		status: 'paused',
		      		created_at: Date.now(),
		      		project_id: project_id,
		      		intervals: []
		    	};
		  	} else {
		    	throw err;
		  	}
		}).then( taskDoc => {
		  	return this.db.put( taskDoc ).then( result => {
		  		return taskDoc;
		  	});
		}).catch( err => {
			console.error( err );
		  	return null;
		});
	}

	getTask( id ) {
		return this.db.get(id).then( result => {

		}).catch( error => {
			console.error( error );
		});
	}
}