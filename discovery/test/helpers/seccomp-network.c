// Linux positive control creates and connects a filesystem AF_UNIX socket via
// io_uring. The same kernel under our BPF must refuse all io_uring entry points.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/io_uring.h>
#include <linux/seccomp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <unistd.h>
struct ring {int fd; void *sq, *cq; struct io_uring_sqe *entries; struct io_uring_params p;};
static int setup(struct ring *r) {
  memset(r,0,sizeof(*r));r->fd=syscall(__NR_io_uring_setup,8,&r->p);
  if(r->fd<0)return -1;
  size_t sqsize=r->p.sq_off.array+r->p.sq_entries*sizeof(unsigned),cqsize=r->p.cq_off.cqes+r->p.cq_entries*sizeof(struct io_uring_cqe);
  if(r->p.features&IORING_FEAT_SINGLE_MMAP){if(cqsize>sqsize)sqsize=cqsize;}
  r->sq=mmap(NULL,sqsize,PROT_READ|PROT_WRITE,MAP_SHARED,r->fd,IORING_OFF_SQ_RING);
  r->cq=(r->p.features&IORING_FEAT_SINGLE_MMAP)?r->sq:mmap(NULL,cqsize,PROT_READ|PROT_WRITE,MAP_SHARED,r->fd,IORING_OFF_CQ_RING);
  r->entries=mmap(NULL,r->p.sq_entries*sizeof(*r->entries),PROT_READ|PROT_WRITE,MAP_SHARED,r->fd,IORING_OFF_SQES);
  return r->sq==MAP_FAILED||r->cq==MAP_FAILED||r->entries==MAP_FAILED?-1:0;
}
static int submit(struct ring *r,struct io_uring_sqe entry) {
  unsigned *tail=r->sq+r->p.sq_off.tail,*mask=r->sq+r->p.sq_off.ring_mask,*array=r->sq+r->p.sq_off.array;
  unsigned index=*tail&*mask;r->entries[index]=entry;array[index]=index;
  __atomic_store_n(tail,*tail+1,__ATOMIC_RELEASE);
  if(syscall(__NR_io_uring_enter,r->fd,1,1,IORING_ENTER_GETEVENTS,NULL,0)<0)return -errno;
  unsigned *head=r->cq+r->p.cq_off.head,*cqmask=r->cq+r->p.cq_off.ring_mask;
  struct io_uring_cqe *cqes=r->cq+r->p.cq_off.cqes;
  int result=cqes[*head&*cqmask].res;__atomic_store_n(head,*head+1,__ATOMIC_RELEASE);return result;
}
static int denied(long result) {return result==-1&&errno==EPERM;}
int main(int argc,char **argv) {
  if(argc<3)return 1;
  struct sockaddr_un address={.sun_family=AF_UNIX};snprintf(address.sun_path,sizeof(address.sun_path),"%s",argv[2]);
  if(!strcmp(argv[1],"control")) {
    struct ring r;if(setup(&r))return 77;
    struct io_uring_sqe entry={.opcode=IORING_OP_SOCKET,.fd=AF_UNIX,.off=SOCK_STREAM};
    int socket=submit(&r,entry);if(socket<0)return 77;
    entry=(struct io_uring_sqe){.opcode=IORING_OP_CONNECT,.fd=socket,.addr=(uintptr_t)&address,.off=sizeof(address)};
    int result=submit(&r,entry);if(result<0){fprintf(stderr,"async connect failed: %d\n",result);return 1;}
    // write on the connected fd is synchronous; socket creation and connect
    // already exercised the asynchronous path that bypassed the old filter.
    if(write(socket,"async",5)!=5)return 1;
    close(socket);close(r.fd);return 0;
  }
  if(argc!=4)return 1;
  int fd=open(argv[3],O_RDONLY);struct stat st;if(fd<0||fstat(fd,&st))return 1;
  struct sock_filter *bytes=malloc(st.st_size);if(!bytes||read(fd,bytes,st.st_size)!=st.st_size)return 1;close(fd);
  struct sock_fprog program={.len=st.st_size/sizeof(*bytes),.filter=bytes};
  if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program))return 1;
  if(!denied(socket(AF_UNIX,SOCK_STREAM,0)))return 2;
  struct io_uring_params p={0};if(!denied(syscall(__NR_io_uring_setup,8,&p)))return 3;
  if(!denied(syscall(__NR_io_uring_enter,-1,0,0,0,NULL,0)))return 4;
  if(!denied(syscall(__NR_io_uring_register,-1,0,NULL,0)))return 5;
  if(!denied(syscall(9999)))return 6;
  return 0;
}
